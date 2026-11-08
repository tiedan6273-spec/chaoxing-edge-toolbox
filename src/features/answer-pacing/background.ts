import { broadcastPublic, privateStorageReady, type BackgroundRoutes } from '../../core/background-context';
import { createRequestPacer, type Provider } from './scheduler';
import { normalizeAnswerPacing, PACING_SETTINGS_KEY, validateAnswerPacing } from './types';

const SESSION_KEY = 'toolbox.answer-pacing.starts.v1';
async function readStoredPacing() {
  await privateStorageReady;
  const stored = await chrome.storage.local.get(PACING_SETTINGS_KEY);
  return normalizeAnswerPacing(stored[PACING_SETTINGS_KEY]);
}

let pacer: Promise<ReturnType<typeof createRequestPacer>> | undefined;
function getPacer() {
  return pacer ??= (async () => {
    const initial: Partial<Record<Provider, number>> = {};
    try {
      const value: unknown = (await chrome.storage.session?.get(SESSION_KEY))?.[SESSION_KEY];
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      for (const source of ['ai', 'bank'] as const) {
        if (typeof record?.[source] === 'number' && Number.isFinite(record[source])) initial[source] = record[source];
      }
    } catch { /* Session timestamps are best effort; no credentials are stored here. */ }
    return createRequestPacer({
      initial,
      interval: async source => (await readStoredPacing())[source === 'ai' ? 'aiIntervalMs' : 'bankIntervalMs'],
      onStart(source, at) {
        initial[source] = at;
        void chrome.storage.session?.set({ [SESSION_KEY]: { ...initial } }).catch(() => {});
      },
    });
  })();
}

export async function waitForProvider(source: Provider, signal: AbortSignal, onWait?: (text: string) => void): Promise<void> {
  if (signal.aborted) throw new DOMException('已暂停等待。', 'AbortError');
  await (await getPacer()).wait(source, signal, onWait);
}

export const pacingRoutes: BackgroundRoutes = {
  'toolbox:answer-pacing:read': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: readStoredPacing },
  'toolbox:answer-pacing:save': { access: 'options', handle: async message => {
    validateAnswerPacing(message.preferences);
    await privateStorageReady;
    await chrome.storage.local.set({ [PACING_SETTINGS_KEY]: normalizeAnswerPacing(message.preferences) });
  } },
};

export function subscribeStoredPacing(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PACING_SETTINGS_KEY]) void broadcastPublic({ type: 'toolbox:answer-pacing:changed' }, ['chaoxing', 'zjooc']);
  });
}
