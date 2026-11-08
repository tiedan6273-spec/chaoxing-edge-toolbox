import { isFeatureId, type FeatureId } from '../features/catalog';
import type { Settings } from './settings';
import { normalizeZjoocPlaybackRate } from '../features/zjooc-study/playback-rate';
import { normalizeZjoocStartMode } from '../features/zjooc-study/start-position';
import type { AnswerSnapshot, AnswerWriteRequest, AnswerWriteResult, CurrentQuestion } from '../features/ai-answer/types';
import type { StudyPageRequest, StudyPageResult, StudyTaskProgress } from '../features/chapter-study/types';
import { isStudyPageRequest, isStudyPageResult, isStudyProgress } from '../features/chapter-study/protocol';
import type { AnswerPageCommand, AnswerPageResult } from '../features/question-answer/types';
import { isAnswerPageCommand, isAnswerPageResult } from '../features/question-answer/protocol';

const CHANNEL = 'chaoxing-toolbox:page:v1';
export type BridgeMessage =
  | { channel: typeof CHANNEL; kind: 'ready' }
  | { channel: typeof CHANNEL; kind: 'apply'; revision: number; settings: Settings }
  | { channel: typeof CHANNEL; kind: 'applied'; revision: number; activeFeatures: FeatureId[]; errors: string[] }
  | { channel: typeof CHANNEL; kind: 'editor-read'; requestId: string }
  | { channel: typeof CHANNEL; kind: 'editor-write'; requestId: string; request: AnswerWriteRequest }
  | { channel: typeof CHANNEL; kind: 'editor-result'; requestId: string; result: AnswerSnapshot | AnswerWriteResult }
  | { channel: typeof CHANNEL; kind: 'answer-command'; requestId: string; command: AnswerPageCommand }
  | { channel: typeof CHANNEL; kind: 'answer-result'; requestId: string; result: AnswerPageResult }
  | { channel: typeof CHANNEL; kind: 'study-command'; requestId: string; request: StudyPageRequest }
  | { channel: typeof CHANNEL; kind: 'study-progress'; requestId: string; progress: StudyTaskProgress }
  | { channel: typeof CHANNEL; kind: 'study-result'; requestId: string; result: StudyPageResult };

export interface PageBridge {
  send(message: BridgeMessage): void;
  dispose(): void;
}

/**
 * Transfer one private port before page scripts run. Capturing and consuming the
 * bootstrap event prevents later page message listeners from taking its port.
 * Neither end accepts settings from the public window message stream afterward.
 */
export function installMainBridge(win: Window, onMessage: (message: BridgeMessage) => void): PageBridge {
  let port: MessagePort | undefined;
  const connect = (event: MessageEvent) => {
    if (!event.isTrusted || event.source !== win || event.data?.channel !== CHANNEL || event.data?.kind !== 'connect' || !event.ports[0]) return;
    event.stopImmediatePropagation();
    win.removeEventListener('message', connect, true);
    port = event.ports[0];
    port.onmessage = (incoming) => {
      const message = parseBridgeData(incoming.data);
      if (message) onMessage(message);
    };
    port.postMessage(bridgeMessage({ kind: 'ready' }));
  };
  win.addEventListener('message', connect, true);
  return {
    send(message) { port?.postMessage(message); },
    dispose() { win.removeEventListener('message', connect, true); port?.close(); },
  };
}

export function connectIsolatedBridge(win: Window, onMessage: (message: BridgeMessage) => void): PageBridge {
  const connection = new MessageChannel();
  connection.port1.onmessage = (event) => {
    const message = parseBridgeData(event.data);
    if (message) onMessage(message);
  };
  win.postMessage({ channel: CHANNEL, kind: 'connect' }, '*', [connection.port2]);
  return { send: (message) => connection.port1.postMessage(message), dispose: () => connection.port1.close() };
}

type BridgeInput = BridgeMessage extends infer Message ? Message extends BridgeMessage ? Omit<Message, 'channel'> : never : never;
export function bridgeMessage(message: BridgeInput): BridgeMessage {
  return { channel: CHANNEL, ...message } as BridgeMessage;
}

/** The shared page world is untrusted: accept only a small, bounded protocol. */
export function parseBridgeData(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (value.channel !== CHANNEL) return null;
  if (value.kind === 'ready') return { channel: CHANNEL, kind: 'ready' };
  if (typeof value.requestId === 'string' && /^[\w-]{1,100}$/.test(value.requestId)) {
    if (value.kind === 'answer-command' && isAnswerPageCommand(value.command)) return value as unknown as BridgeMessage;
    if (value.kind === 'answer-result' && isAnswerPageResult(value.result)) return value as unknown as BridgeMessage;
    if (value.kind === 'study-command' && isStudyPageRequest(value.request)) return value as unknown as BridgeMessage;
    if (value.kind === 'study-result' && isStudyPageResult(value.result)) return value as unknown as BridgeMessage;
    if (value.kind === 'study-progress' && isStudyProgress(value.progress)) return value as unknown as BridgeMessage;
    if (value.kind === 'editor-read') return value as unknown as BridgeMessage;
    if (value.kind === 'editor-write') {
      const request = value.request as Partial<AnswerWriteRequest> | undefined;
      const question = request?.question as Partial<CurrentQuestion> | undefined;
      if (request && question?.type === '简答题' && typeof question.key === 'string' && question.key.length < 1000
          && typeof question.fingerprint === 'string' && question.fingerprint.length < 1000
          && typeof request.expectedVersion === 'string' && request.expectedVersion.length < 200000
          && typeof request.text === 'string' && request.text.length <= 32000) return value as unknown as BridgeMessage;
    }
    if (value.kind === 'editor-result') {
      const result = value.result as Partial<AnswerSnapshot & AnswerWriteResult> | undefined;
      if (result && (typeof result.ok === 'boolean' || (typeof result.ready === 'boolean'
          && typeof result.hasContent === 'boolean' && typeof result.version === 'string'
          && typeof result.text === 'string'))) return value as unknown as BridgeMessage;
    }
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return null;
  if (value.kind === 'apply') {
    const settings = value.settings as Settings | undefined;
    if (!settings || settings.version !== 1 || typeof settings.enabled !== 'boolean'
        || !settings.features || typeof settings.features !== 'object') return null;
    const features: Partial<Settings['features']> = {};
    for (const [key, enabled] of Object.entries(settings.features)) {
      if (!isFeatureId(key) || typeof enabled !== 'boolean') return null;
      features[key] = enabled;
    }
    return { channel: CHANNEL, kind: 'apply', revision: value.revision as number, settings: {
      version: 1, enabled: settings.enabled, features: features as Settings['features'],
      zjoocPlaybackRate: normalizeZjoocPlaybackRate(settings.zjoocPlaybackRate),
      zjoocStartMode: normalizeZjoocStartMode(settings.zjoocStartMode),
    } };
  }
  if (value.kind === 'applied' && Array.isArray(value.activeFeatures) && value.activeFeatures.every(isFeatureId)
      && Array.isArray(value.errors) && value.errors.length <= 20
      && value.errors.every((error) => typeof error === 'string' && error.length < 500)) {
    return value as unknown as BridgeMessage;
  }
  return null;
}
