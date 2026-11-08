import { isSupportedContent } from '../../core/background-context';
import { requestChatCompletion } from '../api-settings/metered-client';
import { API_SETTINGS_KEY, AI_GENERATION_PORT } from '../api-settings/types';
import { PACING_SETTINGS_KEY } from '../answer-pacing/types';
import { SETTINGS_KEY } from '../toolbox-settings/types';
import { readStoredSettings } from '../toolbox-settings/background';
import { buildAnswerMessages } from './prompt';
import { isThinkLadderUrl } from './adapters/think-ladder';
import type { CurrentQuestion } from './types';
import { resolveQuestionAnswer } from '../question-answer/generation-background';
import { readAnswerSourcesStatus } from '../question-answer/source-background';
import { ANSWER_PREFERENCES_KEY } from '../question-answer/types';
import { bankCourseContext } from '../local-question-bank/library-types';
import { onLocalBankChanged } from '../local-question-bank/background';
import { prepareThinkLadder } from './snapshot';

function isQuestion(value: unknown): value is CurrentQuestion {
  if (!value || typeof value !== 'object') return false;
  const question = value as CurrentQuestion;
  return question.type === '简答题' && typeof question.key === 'string' && question.key.length < 1000
    && typeof question.fingerprint === 'string' && question.fingerprint.length < 1000
    && typeof question.stem === 'string' && question.stem.trim().length > 0 && question.stem.length < 16000
    && typeof question.assessment === 'string' && question.assessment.length < 4000
    && Array.isArray(question.knowledgePoints) && question.knowledgePoints.length < 100
    && question.knowledgePoints.every((point) => typeof point === 'string' && point.length < 200);
}

const activeTabs = new Map<number, AbortController>();

export function installAiGenerationBroker(): void {
  onLocalBankChanged(() => { for (const controller of activeTabs.values()) controller.abort(); });
  chrome.tabs.onRemoved.addListener((tabId) => { activeTabs.get(tabId)?.abort(); activeTabs.delete(tabId); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && [API_SETTINGS_KEY, SETTINGS_KEY, PACING_SETTINGS_KEY, ANSWER_PREFERENCES_KEY].some(key => changes[key])) {
      for (const abort of activeTabs.values()) abort.abort();
    }
  });
  chrome.permissions.onRemoved.addListener(() => { for (const abort of activeTabs.values()) abort.abort(); });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AI_GENERATION_PORT) return;
    const sender = port.sender;
    if (!sender || !isSupportedContent(sender, 'chaoxing') || sender.frameId !== 0 || !isThinkLadderUrl(sender.url ?? '') || sender.tab?.id === undefined) {
      port.disconnect();
      return;
    }
    const tabId = sender.tab.id;
    let started = false;
    const abort = new AbortController();
    let connected = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), 45000); };
    const send = (message: Record<string, unknown>) => {
      if (connected) { try { port.postMessage(message); } catch { abort.abort(); } }
    };
    abort.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      if (connected) { connected = false; try { port.disconnect(); } catch { /* Already closed. */ } }
    }, { once: true });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; connected = false; clearTimeout(timer); abort.abort(); });
    port.onMessage.addListener((message: { type?: string; question?: unknown }) => {
      if (message?.type === 'heartbeat') { if (started && !abort.signal.aborted) { touch(); send({ type: 'heartbeat' }); } return; }
      if (message?.type !== 'generate' || started) return;
      started = true;
      if (!isQuestion(message.question)) { send({ type: 'error', error: '当前题目格式无效，未请求 API。' }); return; }
      const question = message.question;
      void (async () => {
        try {
          if (activeTabs.has(tabId)) throw new Error('当前标签页已有生成任务，请先暂停后重试。');
          activeTabs.set(tabId, abort); touch();
          const settings = await readStoredSettings();
          if (!settings.enabled || !settings.features['ai-answer']) throw new Error('AI 作答已关闭，请先开启功能。');
          const context = bankCourseContext(sender.url); const sources = await readAnswerSourcesStatus(context);
          const source = sources.selection ?? (sources.local?.enabled && sources.local.selectedCount ? 'local' : 'ai');
          const result = await resolveQuestionAnswer(prepareThinkLadder(question), source, abort.signal,
            text => send({ type: 'progress', text }), text => send({ type: 'status', text }), context, {
              feature: 'ai-answer', generateAi: async config => {
                const text = await requestChatCompletion(config, buildAnswerMessages(question), abort.signal, value => send({ type: 'progress', text: value }));
                return { status: text.trim() ? 'answer' : 'no-answer', source: 'ai', text, answer: { texts: [text] } };
              },
            });
          if (result.status !== 'answer' || !result.answer?.texts?.[0]?.trim()) throw new Error(result.message ?? '当前来源没有返回完整简答答案。');
          if (!abort.signal.aborted) send({ type: 'result', text: result.answer.texts[0], source: result.source, ...(result.localProof ? { localProof: result.localProof } : {}) });
        } catch (error) {
          if (!abort.signal.aborted) send({ type: 'error', error: error instanceof Error ? error.message : '生成失败，请手动重试。' });
        } finally {
          clearTimeout(timer);
          if (activeTabs.get(tabId) === abort) activeTabs.delete(tabId);
        }
      })();
    });
  });
}
