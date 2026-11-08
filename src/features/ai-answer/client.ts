import { AI_GENERATION_PORT } from '../api-settings/types';
import type { AiGeneratedAnswer, CurrentQuestion } from './types';

/** The content side never receives a key, model endpoint or arbitrary-fetch capability. */
export function generateAnswer(question: CurrentQuestion, signal: AbortSignal, onProgress: (text: string) => void, onStatus: (text: string) => void = () => {}): Promise<AiGeneratedAnswer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('已取消生成。')); return; }
    let port: chrome.runtime.Port;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let timeout = setTimeout(() => finish(undefined, '模型连接超时，请手动重试。'), 45000);
    const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => finish(undefined, '模型连接超时，请手动重试。'), 45000); };
    function finish(result?: AiGeneratedAnswer, error?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener('abort', cancel);
      try { port?.disconnect(); } catch { /* The worker may have disconnected already. */ }
      if (error) reject(new Error(error));
      else resolve(result ?? { text: '' });
    }
    function cancel(): void { finish(undefined, '已取消生成。'); }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      port = chrome.runtime.connect({ name: AI_GENERATION_PORT });
      port.onMessage.addListener((message: { type?: string; text?: string; error?: string; source?: string; localProof?: AiGeneratedAnswer['localProof'] }) => {
        if (settled) return;
        touch();
        if (message.type === 'progress' && typeof message.text === 'string') onProgress(message.text);
        else if (message.type === 'status' && typeof message.text === 'string') onStatus(message.text);
        else if (message.type === 'result' && typeof message.text === 'string') finish({ text: message.text, source: message.source, localProof: message.localProof });
        else if (message.type === 'error') finish(undefined, message.error ?? '模型生成失败，请手动重试。');
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!settled) finish(undefined, '生成连接已中断，请手动重试。');
      });
      port.postMessage({ type: 'generate', question });
      heartbeat = setInterval(() => {
        try { port.postMessage({ type: 'heartbeat' }); } catch { finish(undefined, '生成连接已中断。'); }
      }, 15000);
    } catch { finish(undefined, '扩展连接不可用，请刷新页面后重试。'); }
  });
}
