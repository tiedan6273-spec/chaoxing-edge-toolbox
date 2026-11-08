import { broadcastPublic, privateStorageReady, type BackgroundRoutes } from '../../core/background-context';
import { readApiStatus } from '../api-settings/background';
import { readQuestionBankStatus } from '../question-bank/background';
import { readStoredSettings } from '../toolbox-settings/background';
import { isFeatureEnabled } from '../toolbox-settings/types';
import { localBankRepository } from '../local-question-bank/background';
import { bankCourseContext } from '../local-question-bank/library-types';
import { ANSWER_PREFERENCES_KEY, type AnswerSourceMode, type AnswerSourcesStatus } from './types';

const isSource = (value: unknown): value is AnswerSourceMode => value === 'ai' || value === 'bank' || value === 'prefer-bank' || value === 'local';

async function readSourceSelection(): Promise<AnswerSourceMode | null> {
  await privateStorageReady;
  const record = await chrome.storage.local.get(ANSWER_PREFERENCES_KEY);
  const value: unknown = record[ANSWER_PREFERENCES_KEY];
  if (!value || typeof value !== 'object') return null;
  const preference = value as { version?: unknown; source?: unknown };
  return preference.version === 1 && isSource(preference.source) ? preference.source : null;
}

/** Only the user's selected mode and public booleans leave the background; no provider is contacted. */
export async function readAnswerSourcesStatus(context = 'manager'): Promise<AnswerSourcesStatus> {
  const [bank, ai, settings, selection] = await Promise.all([readQuestionBankStatus(), readApiStatus(), readStoredSettings(), readSourceSelection()]);
  const local = await (await localBankRepository()).state(context);
  const selectedCount = local.libraries.filter(lib => lib.enabled && lib.count && local.preferences.libraryIds.includes(lib.id)).length;
  return {
    selection: selection ?? (local.preferences.enabled && selectedCount ? 'local' : null),
    local: { enabled: local.preferences.enabled, onlineFallback: local.preferences.onlineFallback, selectedCount, revision: local.revision },
    bank: { configured: bank.configured, authorized: bank.authorized },
    ai: {
      configured: ai.configured,
      authorized: ai.authorized,
      enabled: isFeatureEnabled(settings, 'ai-answer'),
      supportsImages: ai.supportsImages === true,
    },
  };
}

export const answerSourceRoutes: BackgroundRoutes = {
  'toolbox:question-answer:sources': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: async (_, sender) => {
    try { return await readAnswerSourcesStatus(bankCourseContext(sender.url)); }
    catch { throw new Error('无法读取答题来源配置，请重新检查；若仍失败，请重新加载扩展并刷新页面。'); }
  } },
  'toolbox:question-answer:select-source': { access: 'top-page', platforms: ['chaoxing', 'zjooc'], handle: async message => {
    if (!isSource(message.source)) throw new Error('请选择有效的答题来源。');
    await privateStorageReady;
    await chrome.storage.local.set({ [ANSWER_PREFERENCES_KEY]: { version: 1, source: message.source } });
  } },
};

export function subscribeStoredAnswerSource(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[ANSWER_PREFERENCES_KEY]) {
      void broadcastPublic({ type: 'toolbox:question-answer:source-changed' }, ['chaoxing', 'zjooc']);
    }
  });
}
