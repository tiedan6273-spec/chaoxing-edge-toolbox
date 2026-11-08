import type { ApiConfig } from './types';
import { readUsage, type TokenUsage } from '../activity/types';

export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user'; content: string | ChatContentPart[] }
export interface ChatCompletionOptions { totalTimeoutMs?: number; onUsage?(usage: TokenUsage): void }

export class ModelRequestError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ModelRequestError'; }
}

function statusError(status: number): ModelRequestError {
  if (status === 401 || status === 403) return new ModelRequestError('auth', 'API 鉴权失败，请检查 Key 和接口访问权限。');
  if (status === 404) return new ModelRequestError('not-found', '未找到接口或模型，请检查完整地址和模型名称。');
  if (status === 429) return new ModelRequestError('rate-limit', 'API 限流或额度不足，请稍后手动重试。');
  if (status >= 500) return new ModelRequestError('server', '模型服务暂时异常，请稍后手动重试。');
  return new ModelRequestError('request', `模型服务拒绝了请求（HTTP ${status}），请检查接口与模型是否兼容。`);
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : '').join('');
}

function ensureComplete(text: string, finishReason: unknown): string {
  if (finishReason === 'length') throw new ModelRequestError('incomplete', '模型回答被截断，未填入。请调整服务端输出限制后手动重试。');
  if (finishReason === 'content_filter' || finishReason === 'tool_calls' || finishReason === 'function_call') {
    throw new ModelRequestError('incomplete', '模型未返回可直接填入的完整文本回答。');
  }
  if (!text.trim()) throw new ModelRequestError('empty', '模型没有返回正文，未填入。请检查模型配置。');
  if (text.length > 32000) throw new ModelRequestError('too-long', '模型回答过长，未自动填入。');
  return text.trim();
}

/** Provider-neutral Chat Completions client. No Chrome APIs or credentials logging. */
export async function requestChatCompletion(
  config: ApiConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onProgress: (text: string) => void = () => {},
  options: ChatCompletionOptions = {},
): Promise<string> {
  const abort = new AbortController();
  let timedOut = false;
  const cancel = () => abort.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const requestedTimeout = options.totalTimeoutMs;
  const totalTimeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
    ? Math.min(600_000, Math.max(1_000, requestedTimeout)) : 90_000;
  const totalTimer = setTimeout(() => { timedOut = true; abort.abort(); }, totalTimeoutMs);
  // Extension service workers cannot wait indefinitely for response headers.
  const headerTimer = setTimeout(() => { timedOut = true; abort.abort(); }, 25000);
  let receivedResponse = false;
  let usage: TokenUsage | undefined;
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: config.stream ? 'text/event-stream, application/json' : 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages, stream: config.stream,
        ...(config.stream && new URL(config.endpoint).hostname === 'api.deepseek.com' ? { stream_options: { include_usage: true } } : {}) }),
      signal: abort.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
    });
    receivedResponse = true;
    clearTimeout(headerTimer);
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new ModelRequestError('redirect', 'API 接口发生重定向，已停止请求且未向新地址发送 Key。请填写服务商提供的最终 Chat Completions 地址后重新保存。');
    }
    if (!response.ok) throw statusError(response.status);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/event-stream')) {
      const result = await response.json();
      usage = readUsage(result?.usage);
      const choice = result?.choices?.[0];
      if (result?.error || !choice) throw new ModelRequestError('format', '接口未返回兼容的 Chat Completions 响应。');
      const answer = ensureComplete(textContent(choice.message?.content), choice.finish_reason);
      onProgress(answer);
      return answer;
    }
    if (!response.body) throw new ModelRequestError('format', '模型返回了空响应流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let doneMarker = false;
    let finishReason: unknown;
    const consume = (event: string) => {
      const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      if (data === '[DONE]') { doneMarker = true; return; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { throw new ModelRequestError('format', '响应流格式不兼容，未自动填入。'); }
      if (!chunk || typeof chunk !== 'object') throw new ModelRequestError('format', '响应流未返回兼容的 Chat Completions 数据。');
      if (chunk.error) throw new ModelRequestError('server', '模型服务中断了生成，请手动重试。');
      usage = readUsage(chunk.usage) ?? usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      // Only final answer content is collected; provider reasoning fields are never used.
      answer += textContent(choice.delta?.content);
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (answer.length > 32000) throw new ModelRequestError('too-long', '模型回答过长，已停止生成。');
      if (answer) onProgress(answer);
    };
    try {
      while (!doneMarker) {
        const { done, value } = await reader.read();
        buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
        if (buffer.length > 1000000) throw new ModelRequestError('format', '模型响应流异常，已停止生成。');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          consume(event);
        }
        if (done) {
          if (buffer.trim()) consume(buffer);
          break;
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* The stream may already be closed. */ }
      reader.releaseLock();
    }
    if (!doneMarker && !finishReason) throw new ModelRequestError('incomplete', '连接在回答完成前中断，未自动填入。');
    return ensureComplete(answer, finishReason);
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    if (timedOut) throw new ModelRequestError('timeout', '模型请求超时，未填入。请检查接口响应速度后手动重试。');
    if (signal.aborted) throw new ModelRequestError('cancelled', '已取消生成。');
    if (error instanceof SyntaxError) throw new ModelRequestError('format', '服务已响应，但返回内容不是兼容的 JSON 或 SSE。请检查完整接口地址及网关响应格式。');
    if (receivedResponse) throw new ModelRequestError('incomplete', '已连接模型服务，但读取响应时连接中断，未填入。请检查网络或代理后手动重试。');
    let detail = error instanceof Error ? `${error.name}: ${error.message}` : '浏览器未提供具体原因';
    for (const secret of [config.apiKey, encodeURIComponent(config.apiKey)]) {
      if (secret) detail = detail.split(secret).join('[已隐藏]');
    }
    detail = detail.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]').slice(0, 200);
    console.warn('模型请求在收到 HTTP 响应前失败：', detail);
    throw new ModelRequestError('network', `请求未获得模型服务的可读响应。原始原因：${detail}。请检查 Edge 的网络或代理，以及 API 域名授权。`);
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(headerTimer);
    signal.removeEventListener('abort', cancel);
    if (usage) options.onUsage?.(usage);
  }
}
