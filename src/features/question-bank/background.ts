import { broadcastPublic, privateStorageReady, type BackgroundRoutes } from '../../core/background-context';
import { readStoredApiSettings, withApiConfigMutation } from '../api-settings/background';
import { apiOrigin } from '../api-settings/types';
import {
  QUESTION_BANK_ORIGIN, QUESTION_BANK_SETTINGS_KEY, emptyQuestionBankConfig, normalizeQuestionBankConfig,
  validateQuestionBankConfig, type QuestionBankConfig, type QuestionBankStatus,
} from './types';

export async function readStoredQuestionBankConfig(): Promise<QuestionBankConfig> {
  await privateStorageReady;
  const record = await chrome.storage.local.get(QUESTION_BANK_SETTINGS_KEY);
  return normalizeQuestionBankConfig(record[QUESTION_BANK_SETTINGS_KEY]);
}

export async function requireQuestionBankConfig(): Promise<QuestionBankConfig> {
  const config = await readStoredQuestionBankConfig();
  validateQuestionBankConfig(config);
  if (!await chrome.permissions.contains({ origins: [QUESTION_BANK_ORIGIN] })) {
    throw new Error('言溪题库域名尚未授权，请前往设置重新保存并授权。');
  }
  return config;
}

export async function readQuestionBankStatus(): Promise<QuestionBankStatus> {
  const config = await readStoredQuestionBankConfig();
  try { validateQuestionBankConfig(config); } catch {
    return { configured: false, authorized: false, message: '尚未配置言溪题库，请在设置页粘贴题库配置或填写 Token。' };
  }
  const authorized = await chrome.permissions.contains({ origins: [QUESTION_BANK_ORIGIN] });
  return { configured: true, authorized, message: authorized ? '言溪题库已配置。' : '言溪题库域名尚未授权，请重新保存。' };
}

export const questionBankRoutes: BackgroundRoutes = {
  'toolbox:question-bank:status': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: async () => readQuestionBankStatus() },
  'toolbox:question-bank:read': { access: 'options', handle: async () => readStoredQuestionBankConfig() },
  'toolbox:question-bank:save': { access: 'options', handle: async (message) => withApiConfigMutation(async () => {
    const config = normalizeQuestionBankConfig(message.config);
    validateQuestionBankConfig(config);
    if (!await chrome.permissions.contains({ origins: [QUESTION_BANK_ORIGIN] })) throw new Error('请先授权言溪题库域名。');
    await privateStorageReady;
    await chrome.storage.local.set({ [QUESTION_BANK_SETTINGS_KEY]: config });
  }) },
  'toolbox:question-bank:clear': { access: 'options', handle: async () => withApiConfigMutation(async () => {
    await privateStorageReady;
    await chrome.storage.local.set({ [QUESTION_BANK_SETTINGS_KEY]: emptyQuestionBankConfig() });
    // Optional host permissions can be shared by the user's configured model endpoint.
    let shared = false;
    try { const api = await readStoredApiSettings(); shared = api.profiles.some(p => apiOrigin(p.config.endpoint) === QUESTION_BANK_ORIGIN); } catch { /* Invalid model config cannot own a permission. */ }
    if (!shared) { try { await chrome.permissions.remove({ origins: [QUESTION_BANK_ORIGIN] }); } catch { /* The token is already cleared. */ } }
  }) },
};

export function subscribeStoredQuestionBank(): void {
  const changed = () => { void broadcastPublic({ type: 'toolbox:question-bank:changed' }, ['chaoxing', 'zjooc']); };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[QUESTION_BANK_SETTINGS_KEY]) changed();
  });
  chrome.permissions.onAdded.addListener(changed);
  chrome.permissions.onRemoved.addListener(changed);
}
