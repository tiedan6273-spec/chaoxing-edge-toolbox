import { isSupportedContent, senderPlatform } from '../../core/background-context';
import type { PlatformId } from '../../shared/sites';
import { readStoredSettings } from '../toolbox-settings/background';
import { isAnswerPageCommand, isAnswerPageResult } from './protocol';
import { canUseQuestionAnswerOperation } from './permissions';
import { assessmentResourceKey, createAnswerOwnership } from './ownership';
import { onLocalBankChanged, validateLocalAnswerProof } from '../local-question-bank/background';
import { bankCourseContext, type LocalAnswerProof } from '../local-question-bank/library-types';
import { ANSWER_FRAME_PORT, type AnswerPageCommand, type AnswerPageResult, type QuestionPageSnapshot } from './types';

interface Pending { resolve(result: AnswerPageResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Peer {
  platform: PlatformId;
  port: chrome.runtime.Port; frameId: number; documentId?: string; snapshot?: QuestionPageSnapshot;
  pending: Map<string, Pending>; epoch: number; heartbeat?: ReturnType<typeof setInterval>;
  flowAttempt?: string;
  ownershipEpoch?: number;
}
export interface AnswerFrameSnapshot { frameId: number; documentId?: string; snapshot: QuestionPageSnapshot }

/** Frame identity is assigned by Chrome, never by page messages. No secrets use this transport. */
export function installQuestionAnswerBroker(): void {
  const tabs = new Map<number, Map<number, Peer>>();
  const ownership = createAnswerOwnership<Peer>();
  const relevant = (peer: Peer) => peer.frameId === 0 || Boolean(peer.snapshot && peer.snapshot.scene !== 'unsupported')
    || /\/(?:work|exam)\//i.test(peer.port.sender?.url ?? '');
  const changed = (peers: Map<number, Peer>) => {
    try { peers.get(0)?.port.postMessage({ kind: 'frame-changed' }); } catch { /* The owner has left. */ }
  };
  const idle = (peer: Peer) => {
    if (!peer.pending.size) { clearInterval(peer.heartbeat); peer.heartbeat = undefined; }
  };
  const fail = (peer: Peer, error = new Error('题目框架已断开或更换，请重新开始。')) => {
    for (const item of peer.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    peer.pending.clear();
    idle(peer);
  };
  const keepAlive = (peer: Peer) => {
    if (peer.heartbeat !== undefined) return;
    peer.heartbeat = setInterval(() => {
      if (!peer.pending.size) { idle(peer); return; }
      try { peer.port.postMessage({ kind: 'heartbeat' }); }
      catch { fail(peer); }
    }, 15000);
  };
  const request = (peer: Peer, command: AnswerPageCommand): Promise<AnswerPageResult> => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      peer.pending.delete(id);
      idle(peer);
      try { peer.port.postMessage({ kind: 'page-request', id: crypto.randomUUID(), command: { action: 'cancel' } }); } catch { /* Disconnected. */ }
      reject(new Error('题目页面操作超时，已停止，请检查页面后重试。'));
    }, command.action === 'finish' ? 45000 : command.action === 'images' ? 35000 : command.action === 'inspect' ? 20000 : 8000);
    peer.pending.set(id, { resolve, reject, timer });
    keepAlive(peer);
    try { peer.port.postMessage({ kind: 'page-request', id, command }); }
    catch { clearTimeout(timer); peer.pending.delete(id); idle(peer); reject(new Error('题目框架无法连接。')); }
  });
  const cancel = (peers: Map<number, Peer>) => {
    for (const peer of peers.values()) {
      fail(peer, new Error('答题已暂停。'));
      const epoch = peer.ownershipEpoch;
      void request(peer, { action: 'cancel' }).then(result => {
        if (result.ok && epoch === peer.ownershipEpoch) ownership.release(peer);
      }).catch(() => { /* Keep ownership until the frame acknowledges or disconnects. */ });
    }
  };
  onLocalBankChanged(() => { for (const peers of tabs.values()) { const owner = peers.get(0); if (owner) owner.epoch++; cancel(peers); changed(peers); } });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== ANSWER_FRAME_PORT) return;
    if (!port.sender || !isSupportedContent(port.sender) || port.sender.frameId === undefined) { port.disconnect(); return; }
    const tabId = port.sender.tab!.id!;
    const peers = tabs.get(tabId) ?? new Map<number, Peer>();
    tabs.set(tabId, peers);
    const frameId = port.sender.frameId;
    const previous = peers.get(frameId);
    if (previous) { fail(previous); ownership.release(previous); if (frameId === 0) cancel(peers); }
    const peer: Peer = { port, frameId, platform: senderPlatform(port.sender)!, documentId: port.sender.documentId, pending: new Map(), epoch: 0 };
    peers.set(frameId, peer);
    if (frameId !== 0 && (relevant(peer) || previous && relevant(previous))) changed(peers);
    port.onDisconnect.addListener(() => {
      // Chromium reports BFCache channel closure through this callback, including on stale ports.
      void chrome.runtime.lastError;
      if (peers.get(frameId) !== peer) return;
      peers.delete(frameId); fail(peer);
      ownership.release(peer);
      if (frameId !== 0 && relevant(peer)) changed(peers);
      if (frameId === 0) cancel(peers);
      if (!peers.size) tabs.delete(tabId);
    });
    port.onMessage.addListener((value: unknown) => {
      if (!value || typeof value !== 'object' || peers.get(frameId) !== peer) return;
      const message = value as Record<string, unknown>;
      if (typeof message.id !== 'string' || !/^[\w-]{1,100}$/.test(message.id)) return;
      if (message.kind === 'invalidate') {
        if (relevant(peer)) { peer.snapshot = undefined; changed(peers); }
        return;
      }
      if (message.kind === 'page-result' && isAnswerPageResult(message.result)) {
        const pending = peer.pending.get(message.id);
        if (pending) { clearTimeout(pending.timer); peer.pending.delete(message.id); idle(peer); pending.resolve(message.result); }
        return;
      }
      if (frameId !== 0 || message.kind !== 'request') return;
      const epoch = peer.epoch;
      const checkOwner = () => {
        if (peers.get(0) !== peer || peer.epoch !== epoch) throw new Error('答题已暂停或页面已更换。');
      };
      const execute = async () => {
        if (message.operation === 'cancel') { peer.epoch++; cancel(peers); return true; }
        if (message.operation === 'scan') {
          if (!canUseQuestionAnswerOperation(await readStoredSettings(), 'scan')) throw new Error('请先开启题目提取或批量答题。');
          checkOwner();
          const results = await Promise.allSettled([...peers.values()].filter(target => target.platform === peer.platform).map(async target => {
            const result = await request(target, { action: 'inspect' });
            if (peers.get(target.frameId) !== target || !result.ok || !result.snapshot) return undefined;
            target.snapshot = result.snapshot;
            return { frameId: target.frameId, documentId: target.documentId, snapshot: result.snapshot };
          }));
          checkOwner();
          return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
        }
        if (message.operation !== 'page' || !Number.isSafeInteger(message.frameId) || !isAnswerPageCommand(message.command)) throw new Error('无效的答题命令。');
        const command = message.command;
        if (command.action !== 'cancel' && !canUseQuestionAnswerOperation(await readStoredSettings(), command.action)) {
          throw new Error(command.action === 'inspect' || command.action === 'read' ? '请先开启题目提取或批量答题。' : '批量答题已关闭。');
        }
        checkOwner();
        const target = peers.get(message.frameId as number);
        if (!target || target.platform !== peer.platform || target.documentId !== message.documentId) throw new Error('题目框架已更换，请重新扫描。');
        if (command.action !== 'inspect' && command.action !== 'cancel') {
          if (!target.snapshot || target.snapshot.documentKey !== command.documentKey || target.snapshot.scopeKey !== command.scopeKey) throw new Error('题目已离开当前答题范围。');
          if ('key' in command && !target.snapshot.questions.some(question => question.key === command.key && question.fingerprint === command.fingerprint)) throw new Error('题目内容已变化，请重新扫描。');
          if (command.action === 'finish' && target.snapshot.scene !== 'chapter-test') throw new Error('自动保存或提交只用于章节测验联动。');
        }
        if (command.action === 'write' && message.localProof !== undefined) {
          if (!await validateLocalAnswerProof(message.localProof as LocalAnswerProof, bankCourseContext(port.sender?.url))) throw new Error('本地题库已删除、停用或改变，请重新匹配，未填写旧答案。');
          checkOwner();
        }
        if (command.action === 'write' || command.action === 'flow' && command.operation !== 'inspect') {
          ownership.claim(target.flowAttempt || assessmentResourceKey(target.port.sender?.url) || assessmentResourceKey(port.sender?.tab?.url), target);
          target.ownershipEpoch = (target.ownershipEpoch ?? 0) + 1;
        }
        const result = await request(target, command);
        checkOwner();
        if (peers.get(target.frameId) !== target) throw new Error('题目页面已更换，旧结果已丢弃。');
        if (result.snapshot) target.snapshot = result.snapshot;
        if (command.action === 'flow' && command.operation === 'inspect' && result.flow?.attemptKey) target.flowAttempt = result.flow.attemptKey;
        return result;
      };
      void execute().then(result => {
        if (peers.get(0) === peer) port.postMessage({ kind: 'response', id: message.id, result });
      }).catch(error => {
        try { port.postMessage({ kind: 'response', id: message.id, error: error instanceof Error ? error.message : '答题操作失败。' }); } catch { /* Owner left. */ }
      });
    });
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    const peers = tabs.get(tabId); tabs.delete(tabId);
    for (const peer of peers?.values() ?? []) { fail(peer); ownership.release(peer); }
  });
}
