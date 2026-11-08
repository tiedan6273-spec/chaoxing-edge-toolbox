import { bridgeMessage, type BridgeMessage, type PageBridge } from '../../shared/bridge';
import { requestExtension } from '../../core/extension-rpc';
import { isFeatureEnabled, type Settings } from '../toolbox-settings/types';
import type { AnswerFrameSnapshot } from './background';
import { isAnswerPageCommand, isAnswerPageResult } from './protocol';
import { canUseQuestionAnswerOperation } from './permissions';
import { observeQuestionStructure } from './structure';
import { isQuestionReviewResult, type QuestionReviewRequest, type QuestionReviewResult } from './review';
import type { LocalAnswerProof } from '../local-question-bank/library-types';
import {
  ANSWER_FRAME_PORT, ANSWER_GENERATION_PORT, type AnswerPageCommand, type AnswerPageResult,
  type AnswerResult, type AnswerSourceMode, type AnswerSourcesStatus, type PreparedQuestion, type QuestionTarget,
} from './types';

export const getAnswerSourcesStatus = (): Promise<AnswerSourcesStatus> => requestExtension('toolbox:question-answer:sources');
export const saveAnswerSource = (source: AnswerSourceMode): Promise<void> => requestExtension('toolbox:question-answer:select-source', { source });

export function subscribeAnswerSource(listener: () => void): () => void {
  const onMessage = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'toolbox:question-answer:source-changed') listener();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}

export interface AnswerRuntime {
  scan(signal: AbortSignal): Promise<AnswerFrameSnapshot[]>;
  page(target: Pick<QuestionTarget, 'frameId' | 'documentId'>, command: AnswerPageCommand, signal: AbortSignal, localProof?: LocalAnswerProof): Promise<AnswerPageResult>;
  cancel(): void;
  subscribeInvalidation?(listener: () => void): () => void;
}
const cancelled = () => new DOMException('答题已暂停。', 'AbortError');
/** A dead extension port throws English Chrome text; never show that to the page. */
const portGone = (error: unknown): boolean => error instanceof Error
  && /disconnected port|message port closed|extension context invalidated|receiving end does not exist/i.test(error.message);
const connectionLost = (): Error => new Error('扩展后台连接已断开（常见于扩展更新或后台重启）。请刷新本页后重试。');

/** One isolated client per frame; only the top client exposes queue dispatch in its UI. */
export function createQuestionAnswerClient(bridge: PageBridge, getSettings: () => Settings | undefined, win?: Window) {
  let port: chrome.runtime.Port | undefined;
  let disposed = false;
  let suspended = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  const pageOwners = new Map<string, chrome.runtime.Port>();
  const invalidations = new Set<() => void>();
  const cancelPage = () => {
    try { bridge.send(bridgeMessage({ kind: 'answer-command', requestId: crypto.randomUUID(), command: { action: 'cancel' } })); }
    catch { /* The page bridge is already gone. */ }
  };
  const cancelRemote = () => {
    cancelPage();
    try { port?.postMessage({ kind: 'request', id: crypto.randomUUID(), operation: 'cancel' }); } catch { /* Already disconnected. */ }
  };
  const rejectPending = (error: Error) => {
    for (const item of pending.values()) { item.cleanup(); item.reject(error); }
    pending.clear();
  };
  const disconnect = (error: Error) => {
    clearTimeout(reconnect); reconnect = undefined;
    const current = port; port = undefined;
    cancelPage(); pageOwners.clear(); rejectPending(error);
    try { current?.disconnect(); } catch { /* Already closed by the browser. */ }
  };
  const lostConnection = (current: chrome.runtime.Port) => {
    if (port !== current) return;
    disconnect(new Error('答题连接已断开，已暂停；请重新开始。'));
    if (!disposed && !suspended) reconnect = setTimeout(() => {
      reconnect = undefined;
      try { connect(); } catch { /* A reloaded extension requires a fresh page. */ }
    }, 1000);
  };
  const connect = (): chrome.runtime.Port => {
    if (disposed || suspended) throw cancelled();
    if (typeof chrome.runtime?.id !== 'string') { port = undefined; throw connectionLost(); }
    if (port) return port;
    clearTimeout(reconnect); reconnect = undefined;
    let current: chrome.runtime.Port;
    try { current = chrome.runtime.connect({ name: ANSWER_FRAME_PORT }); }
    catch { throw connectionLost(); }
    port = current;
    const send = (message: Record<string, unknown>) => {
      try { current.postMessage(message); } catch { lostConnection(current); }
    };
    current.onMessage.addListener((value: Record<string, unknown>) => {
      if (port !== current || suspended) return;
      if (value.kind === 'frame-changed') { for (const listener of invalidations) listener(); return; }
      if (value.kind === 'heartbeat') { send({ kind: 'pong' }); return; }
      if (value.kind === 'response' && typeof value.id === 'string') {
        const item = pending.get(value.id);
        if (!item) return;
        pending.delete(value.id); item.cleanup();
        if (typeof value.error === 'string') item.reject(new Error(value.error)); else item.resolve(value.result);
      } else if (value.kind === 'page-request' && typeof value.id === 'string' && isAnswerPageCommand(value.command)) {
        const settings = getSettings();
        if (!canUseQuestionAnswerOperation(settings, value.command.action)) {
          send({ kind: 'page-result', id: value.id, result: { ok: false, error: value.command.action === 'inspect' || value.command.action === 'read'
            ? '题目提取与批量答题均未启用，或设置尚未加载。' : '批量答题尚未启用或设置尚未加载。' } });
          return;
        }
        pageOwners.set(value.id, current);
        bridge.send(bridgeMessage({ kind: 'answer-command', requestId: value.id, command: value.command }));
      }
    });
    current.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      lostConnection(current);
    });
    return current;
  };
  const call = (operation: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted || disposed || suspended) { reject(cancelled()); return; }
    const id = crypto.randomUUID();
    const abort = () => { pending.delete(id); cleanup(); cancelRemote(); reject(cancelled()); };
    const timeout = setTimeout(() => { pending.delete(id); cleanup(); cancelRemote(); reject(new Error('答题连接超时，请重新开始。')); }, 50000);
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, cleanup });
    try { connect().postMessage({ kind: 'request', id, operation, ...payload }); }
    catch (error) {
      pending.delete(id); cleanup();
      const current = port;
      if (current && portGone(error)) { lostConnection(current); reject(connectionLost()); return; }
      reject(error);
    }
  });
  const runtime: AnswerRuntime = {
    scan: async signal => {
      if (!canUseQuestionAnswerOperation(getSettings(), 'scan')) throw new Error('请先开启题目提取或批量答题。');
      return await call('scan', {}, signal) as AnswerFrameSnapshot[];
    },
    page: async (target, command, signal, localProof) => {
      if (!canUseQuestionAnswerOperation(getSettings(), command.action)) {
        throw new Error(command.action === 'inspect' || command.action === 'read' ? '请先开启题目提取或批量答题。' : '批量答题已关闭。');
      }
      const result = await call('page', { frameId: target.frameId, documentId: target.documentId, command, ...(localProof ? { localProof } : {}) }, signal);
      if (!isAnswerPageResult(result)) throw new Error('答题页面返回了无效结果。');
      if (!result.ok) throw new Error(result.error || '题目页面操作失败。');
      return result;
    },
    cancel: cancelRemote,
    subscribeInvalidation(listener) { invalidations.add(listener); return () => invalidations.delete(listener); },
  };
  const onHide = () => {
    if (disposed || suspended) return;
    suspended = true;
    cancelRemote();
    disconnect(cancelled());
  };
  const onShow = (event: PageTransitionEvent) => {
    if (disposed || (!suspended && !event.persisted)) return;
    suspended = false;
    // A restored document retains JS objects, but Chromium does not reopen its old extension ports.
    disconnect(cancelled());
    try { connect(); } catch { /* The next explicit operation can report an unavailable extension. */ }
  };
  win?.addEventListener('pagehide', onHide);
  win?.addEventListener('pageshow', onShow);
  connect();
  const stopObserving = win ? observeQuestionStructure(win.document, () => {
    if (disposed || suspended || !port) return;
    try { port.postMessage({ kind: 'invalidate', id: crypto.randomUUID() }); } catch { /* A later explicit refresh reports connection loss. */ }
  }) : undefined;
  return {
    runtime,
    receive(message: BridgeMessage) {
      if (message.kind !== 'answer-result') return;
      const owner = pageOwners.get(message.requestId);
      pageOwners.delete(message.requestId);
      if (owner && owner === port) { try { owner.postMessage({ kind: 'page-result', id: message.requestId, result: message.result }); } catch { /* Disconnected. */ } }
    },
    settingsChanged() { const settings = getSettings(); if (!settings || !isFeatureEnabled(settings, 'question-answer')) runtime.cancel(); },
    dispose() {
      stopObserving?.(); invalidations.clear();
      disposed = true; runtime.cancel(); disconnect(cancelled());
      win?.removeEventListener('pagehide', onHide); win?.removeEventListener('pageshow', onShow);
    },
  };
}

export function generateQuestionAnswer(prepared: PreparedQuestion, source: AnswerSourceMode, signal: AbortSignal, onProgress: (text: string) => void, onStatus: (text: string) => void = () => {}): Promise<AnswerResult> {
  return generationPortRequest('generate', {
    // Rich copy text is a view-only projection, not part of the provider protocol.
    // Delete the key even when undefined; do not rely on transport serialization.
    prepared: { ...prepared, question: (() => {
      const question = { ...prepared.question };
      delete question.markdown;
      delete question.reviewData;
      return question;
    })() },
    source,
  }, signal, onProgress, onStatus).then(result => result as AnswerResult);
}

export async function reviewQuestionAnswers(
  request: QuestionReviewRequest,
  signal: AbortSignal,
  onProgress: (text: string) => void,
  onStatus: (text: string) => void = () => {},
): Promise<QuestionReviewResult> {
  const result = await generationPortRequest('review', { request }, signal, onProgress, onStatus);
  if (!isQuestionReviewResult(result)) throw new Error('整卷复检服务返回了无效结果，未产生部分标记。');
  return result;
}

function generationPortRequest(
  type: 'generate' | 'review',
  payload: Record<string, unknown>,
  signal: AbortSignal,
  onProgress: (text: string) => void,
  onStatus: (text: string) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: ANSWER_GENERATION_PORT }); }
    catch { reject(connectionLost()); return; }
    let done = false;
    const finish = (result?: unknown, error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(heartbeat); signal.removeEventListener('abort', abort);
      try { port.disconnect(); } catch { /* Already disconnected. */ }
      if (error) reject(error); else if (result) resolve(result); else reject(new Error('答案服务没有返回结果。'));
    };
    const abort = () => finish(undefined, cancelled());
    // Network timeouts belong to providers. A live queue may legitimately wait much longer.
    let timer = setTimeout(() => finish(undefined, new Error('答案服务连接超时，已暂停。')), 45000);
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => finish(undefined, new Error('答案服务连接超时，已暂停。')), 45000); };
    const heartbeat = setInterval(() => {
      if (done) return;
      try { port.postMessage({ type: 'heartbeat' }); }
      catch { finish(undefined, new Error('答案服务连接中断，未填写。')); }
    }, 15000);
    signal.addEventListener('abort', abort, { once: true });
    port.onMessage.addListener((message: { type?: string; text?: string; result?: unknown; error?: string }) => {
      if (done) return;
      touch();
      if (message.type === 'heartbeat') {
        try { port.postMessage({ type: 'pong' }); } catch { finish(undefined, new Error('答案服务连接中断，未填写。')); }
        return;
      }
      if (message.type === 'progress' && typeof message.text === 'string') onProgress(message.text);
      else if (message.type === 'status' && typeof message.text === 'string') onStatus(message.text);
      else if (message.type === (type === 'review' ? 'review-result' : 'result')) finish(message.result);
      else if (message.type === 'error') finish(undefined, new Error(message.error || '答案服务失败。'));
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!done) finish(undefined, new Error('答案服务连接中断，未填写。')); });
    try {
      port.postMessage({ type, ...payload });
    }
    catch (error) { finish(undefined, portGone(error) ? connectionLost() : new Error('答案服务无法连接，请重新开始。')); }
  });
}
