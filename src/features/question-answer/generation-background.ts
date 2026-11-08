import { isSupportedContent } from '../../core/background-context';
import { requireApiConfig } from '../api-settings/background';
import { API_SETTINGS_KEY, type ApiConfig } from '../api-settings/types';
import { ModelRequestError } from '../api-settings/model-client';
import { generateQuestionAnswer, QuestionAiAnswerError } from '../ai-answer/question-provider';
import { requireQuestionBankConfig } from '../question-bank/background';
import { queryQuestionBank, QuestionBankError } from '../question-bank/service';
import { QUESTION_BANK_SETTINGS_KEY } from '../question-bank/types';
import { readStoredSettings } from '../toolbox-settings/background';
import { SETTINGS_KEY } from '../toolbox-settings/types';
import { waitForProvider } from '../answer-pacing/background';
import { PACING_SETTINGS_KEY } from '../answer-pacing/types';
import { isPreparedQuestion } from './protocol';
import { generateQuestionReview, isQuestionReviewRequest, QuestionReviewError } from './review';
import { readAnswerSourcesStatus } from './source-background';
import { onLocalBankChanged, queryStoredLibraries } from '../local-question-bank/background';
import { bankCourseContext } from '../local-question-bank/library-types';
import { formatApplicableAnswer } from './answer-format';
import { planAnswerSource } from './source-status';
import { historyStamp, rememberResult } from '../activity/history-background';
import { ANSWER_GENERATION_PORT, ANSWER_PREFERENCES_KEY, type AnswerResult, type AnswerSourceMode, type PreparedQuestion } from './types';

export { ANSWER_GENERATION_PORT } from './types';

const activeTabs = new Map<number, AbortController>();
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const only = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

class QuestionGenerationError extends Error {}

/** Native/storage errors can contain URLs or other private context; only known local messages cross the port. */
export function generationErrorMessage(error: unknown): string {
  if (error instanceof ModelRequestError && error.code === 'network') return '模型服务网络请求失败，请检查网络和 API 域名权限后手动重试。';
  if (error instanceof QuestionBankError || error instanceof ModelRequestError || error instanceof QuestionAiAnswerError
      || error instanceof QuestionReviewError || error instanceof QuestionGenerationError) {
    return error.message.slice(0, 500);
  }
  return '答题请求失败，请检查配置和网络后手动重试。';
}

/** Accept data only: no endpoint, token, request headers or arbitrary provider settings. */
export function validatePreparedQuestion(value: unknown): value is PreparedQuestion {
  if (!isPreparedQuestion(value) || !only(value, ['question', 'images', 'suggestionTitle', 'suggestionOptions'])) return false;
  const question = value.question;
  if (!question.supported || question.kind === 'unsupported' || !question.key || !question.fingerprint
      || question.textRecognition?.status === 'pending'
      || !only(question, ['key', 'fingerprint', 'number', 'kind', 'stem', 'options', 'fields', 'children', 'images', 'supported', 'reason', 'textRecognition', 'program'])) return false;
  const optionValid = (option: object) => only(option, ['id', 'label', 'text']);
  if (!question.options.every(optionValid) || !question.fields.every(field => only(field, ['id', 'options']) && (!field.options || field.options.every(optionValid)))
      || !question.children.every(child => only(child, ['id', 'stem', 'options']) && child.options.every(optionValid))) return false;
  if (question.images.length !== value.images.length || new Set(question.images).size !== question.images.length) return false;
  if (!question.stem.trim() && !question.images.length) return false;
  if (!question.images.every(image => {
    // The shared question validator has already bounded and validated inline image bytes.
    if (image.startsWith('data:image/')) return true;
    try { const url = new URL(image); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  })) return false;
  let textSize = value.suggestionTitle.length + value.suggestionOptions.length;
  const boundedText = (entry: unknown): boolean => {
    if (typeof entry === 'string') { textSize += entry.length; return textSize <= 256_000; }
    if (Array.isArray(entry)) return entry.every(boundedText);
    return !object(entry) || Object.values(entry).every(boundedText);
  };
  return boundedText({ ...question, images: [] });
}

async function requireAnswerEnabled(ai = false, feature: 'question-answer' | 'ai-answer' = 'question-answer'): Promise<void> {
  const settings = await readStoredSettings();
  if (!settings.enabled || !settings.features[feature]) throw new QuestionGenerationError('当前答题功能已关闭，请先开启功能。');
  if (ai && !settings.features['ai-answer']) throw new QuestionGenerationError('AI 作答已关闭，未请求模型；请启用后重试。');
}

export async function resolveQuestionAnswer(
  prepared: PreparedQuestion, source: AnswerSourceMode, signal: AbortSignal, onProgress: (text: string) => void,
  onStatus: (text: string) => void = onProgress, context = 'manager',
  options: { feature?: 'ai-answer'; generateAi?: (config: ApiConfig) => Promise<AnswerResult> } = {},
): Promise<AnswerResult> {
  await requireAnswerEnabled(false, options.feature);
  if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
  const sources = await readAnswerSourcesStatus(context);
  if (!sources.selection && options.feature === 'ai-answer') sources.selection = sources.local?.enabled && sources.local.selectedCount ? 'local' : 'ai';
  if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
  if (!sources.selection) throw new QuestionGenerationError('请先在答题面板选择答题来源；配置 API 不会自动选择 AI。');
  if (source !== sources.selection) throw new QuestionGenerationError('答题来源已更改，请确认当前选择后重新开始。');
  let plan = planAnswerSource(source, sources, Boolean(prepared.question.textRecognition), prepared.question.kind === 'program');
  if (plan.first === 'local') {
    onStatus('正在匹配本地题库…');
    const match = await queryStoredLibraries(prepared.question, context);
    if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
    if (match.status === 'matched' && match.answer) return {
      status: 'answer', source: 'local-bank', text: formatApplicableAnswer(prepared.question, match.answer), answer: match.answer,
      message: `本地题库参考答案：${match.sources.slice(0, 5).map(item => `${item.name} · ${item.number} · ${item.position}`).join('；')}。请核对。`,
      tags: match.sources.slice(0, 5).map(item => ({ text: item.name, title: `题号 ${item.number}；${item.position}` })),
      localProof: { revision: match.revision, libraryIds: [...new Set(match.sources.map(item => item.libraryId))], entryIds: match.sources.map(item => item.entryId), context },
    };
    if (match.status === 'conflict' || !plan.fallback || source === 'local') return { status: 'no-answer', source: 'local-bank', text: '', message: match.message };
    plan = planAnswerSource(source, { ...sources, local: undefined }, Boolean(prepared.question.textRecognition), prepared.question.kind === 'program');
    onStatus('本地未完整匹配，正在准备所选在线来源…');
  }
  const program = prepared.question.kind === 'program';
  if (program && source === 'bank') return {
    status: 'no-answer', source: 'bank', text: '', message: '程序题需要 AI 生成代码；请将答题来源切换为“仅 AI”或“言溪优先，AI 补充”。',
  };
  const incomplete = Boolean(prepared.question.textRecognition);
  if (incomplete && source === 'bank') return {
    status: 'no-answer', source: 'bank', text: '', message: '本题含未识别文字，未查询言溪题库；请切换为 AI 或“言溪优先，AI 补充”。',
  };
  if (!plan.first) throw new QuestionGenerationError(plan.message);
  if (plan.first === 'bank') {
    const config = await requireQuestionBankConfig().catch(() => { throw new QuestionGenerationError('言溪题库配置不可用，请在设置页检查 Token 和域名授权。'); });
    if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
    await waitForProvider('bank', signal, onStatus);
    if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
    onStatus('正在查询言溪题库…');
    const result = await queryQuestionBank(config, prepared, signal);
    if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
    if (source === 'bank' || result.status === 'answer') return result;
    if (!plan.fallback) return { ...result, message: `言溪未返回可应用答案，本题保留待处理。${plan.message}` };
    onStatus('言溪未返回可应用答案，正在准备 AI 补充…');
  } else if (source === 'prefer-bank') {
    onStatus(program ? '程序题将由 AI 生成代码…' : incomplete ? '本题含未识别文字，跳过言溪题库，正在使用 AI…' : '未配置言溪题库，正在使用 AI 答题…');
  }
  await requireAnswerEnabled(true, options.feature);
  const config = await requireApiConfig(Boolean(prepared.images.length)).catch(() => { throw new QuestionGenerationError('AI 配置不可用，请在设置页检查接口、模型和域名授权。'); });
  if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
  await waitForProvider('ai', signal, onStatus);
  if (signal.aborted) throw new QuestionGenerationError('已取消答题。');
  onStatus(`正在请求 AI 答案 · ${config.model}…`);
  return options.generateAi ? options.generateAi(config) : generateQuestionAnswer(config, prepared, signal, onProgress);
}

export async function resolveQuestionReview(
  request: Parameters<typeof generateQuestionReview>[1],
  signal: AbortSignal,
  onProgress: (text: string) => void,
  onStatus: (text: string) => void = onProgress,
): ReturnType<typeof generateQuestionReview> {
  await requireAnswerEnabled(true);
  if (signal.aborted) throw new QuestionGenerationError('已取消整卷复检。');
  const config = await requireApiConfig(request.items.some(item => item.images.length > 0)).catch(() => {
    throw new QuestionGenerationError('AI 配置不可用，请在设置页检查接口、模型和域名授权。');
  });
  if (signal.aborted) throw new QuestionGenerationError('已取消整卷复检。');
  await waitForProvider('ai', signal, onStatus);
  if (signal.aborted) throw new QuestionGenerationError('已取消整卷复检。');
  onStatus(`步骤 2/3 · AI 整卷复检 · ${config.model}（本次仅一个请求）…`);
  return generateQuestionReview(config, request, signal, onProgress);
}

export function installQuestionGenerationBroker(): void {
  onLocalBankChanged(() => { for (const abort of activeTabs.values()) abort.abort(); });
  chrome.tabs.onRemoved.addListener(tabId => { activeTabs.get(tabId)?.abort(); activeTabs.delete(tabId); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && [SETTINGS_KEY, API_SETTINGS_KEY, QUESTION_BANK_SETTINGS_KEY, ANSWER_PREFERENCES_KEY, PACING_SETTINGS_KEY].some(key => changes[key])) {
      for (const abort of activeTabs.values()) abort.abort();
    }
  });
  chrome.permissions.onRemoved.addListener(() => { for (const abort of activeTabs.values()) abort.abort(); });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== ANSWER_GENERATION_PORT) return;
    const sender = port.sender;
    if (!sender || !isSupportedContent(sender) || sender.frameId !== 0 || sender.tab?.id === undefined) {
      port.disconnect(); return;
    }
    const tabId = sender.tab.id;
    const abort = new AbortController();
    let started = false;
    let connected = true;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHeartbeat = () => { if (heartbeatTimer) clearTimeout(heartbeatTimer); heartbeatTimer = undefined; };
    const send = (message: Record<string, unknown>) => {
      if (!connected || abort.signal.aborted) return;
      try { port.postMessage(message); } catch { abort.abort(); }
    };
    const heartbeat = () => {
      clearHeartbeat();
      // The content client sends a heartbeat every 15 seconds; a vanished page cannot leave a chargeable request running.
      heartbeatTimer = setTimeout(() => { abort.abort(); try { port.disconnect(); } catch { /* Already closed. */ } }, 45000);
    };
    abort.signal.addEventListener('abort', () => {
      clearHeartbeat();
      if (connected) { connected = false; try { port.disconnect(); } catch { /* The sender may already have disconnected. */ } }
    }, { once: true });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; connected = false; clearHeartbeat(); abort.abort(); });
    port.onMessage.addListener((message: unknown) => {
      if (!object(message)) return;
      if (message.type === 'cancel') { abort.abort(); clearHeartbeat(); return; }
      if (message.type === 'heartbeat') { if (started && !abort.signal.aborted) { heartbeat(); send({ type: 'heartbeat' }); } return; }
      if (message.type === 'review' && !started) {
        started = true;
        if (!only(message, ['type', 'request']) || !isQuestionReviewRequest(message.request)) {
          send({ type: 'error', error: '整卷复检数据无效、图片不完整或超出大小限制，未请求模型。' }); return;
        }
        const request = message.request;
        void (async () => {
          try {
            if (activeTabs.has(tabId)) throw new QuestionGenerationError('当前标签页已有答题或复检请求，请暂停后重试。');
            activeTabs.set(tabId, abort); heartbeat();
            const result = await resolveQuestionReview(request, abort.signal,
              text => send({ type: 'progress', text }), text => send({ type: 'status', text }));
            send({ type: 'review-result', result });
          } catch (error) {
            send({ type: 'error', error: generationErrorMessage(error) });
          } finally {
            clearHeartbeat();
            if (activeTabs.get(tabId) === abort) activeTabs.delete(tabId);
          }
        })();
        return;
      }
      if (message.type !== 'generate' || started) return;
      started = true;
      if (!only(message, ['type', 'prepared', 'source']) || !validatePreparedQuestion(message.prepared)
          || !['prefer-bank', 'bank', 'ai', 'local'].includes(String(message.source))) {
        send({ type: 'error', error: '题目数据无效、图片不完整或超出大小限制，未请求题库或模型。' }); return;
      }
      const prepared = message.prepared;
      const source = message.source as AnswerSourceMode;
      void (async () => {
        try {
          if (activeTabs.has(tabId)) throw new QuestionGenerationError('当前标签页已有答题请求，请暂停后重试。');
          activeTabs.set(tabId, abort); heartbeat();
          const stamp = await historyStamp(sender.url!).catch(() => undefined);
          const result = await resolveQuestionAnswer(prepared, source, abort.signal,
            text => send({ type: 'progress', text }), text => send({ type: 'status', text }), bankCourseContext(sender.url));
          if (!abort.signal.aborted && stamp) await rememberResult(sender.url!, prepared.question, result, stamp).catch(() => send({ type: 'status', text: '答案已获取，但历史记录保存失败；请在刷新前导出。' }));
          send({ type: 'result', result });
        } catch (error) {
          send({ type: 'error', error: generationErrorMessage(error) });
        } finally {
          clearHeartbeat();
          if (activeTabs.get(tabId) === abort) activeTabs.delete(tabId);
        }
      })();
    });
  });
}
