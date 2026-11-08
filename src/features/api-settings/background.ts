import { broadcastPublic, privateStorageReady, type BackgroundRoutes } from '../../core/background-context';
import { requestChatCompletion } from './metered-client';
import { API_SETTINGS_KEY, apiOrigin, emptyApiConfig, normalizeApiConfig, validateApiConfig, normalizeApiSettings, emptyApiSettings, rankedProfiles, apiSettingsOrigins, validateApiSettings, type ApiConfig, type ApiStatus, type ApiSettings, type ApiProfile } from './types';
import { QUESTION_BANK_ORIGIN, QUESTION_BANK_SETTINGS_KEY, normalizeQuestionBankConfig } from '../question-bank/types';
import { waitForProvider } from '../answer-pacing/background';
import { PACING_SETTINGS_KEY } from '../answer-pacing/types';

async function releaseApiOrigin(endpoint: string): Promise<void> {
  const origin = apiOrigin(endpoint);
  if (origin === QUESTION_BANK_ORIGIN) {
    const record = await chrome.storage.local.get(QUESTION_BANK_SETTINGS_KEY);
    if (normalizeQuestionBankConfig(record[QUESTION_BANK_SETTINGS_KEY]).token) return;
  }
  await chrome.permissions.remove({ origins: [origin] });
}

export async function readStoredApiSettings(): Promise<ApiSettings> {
  await privateStorageReady;
  const record = await chrome.storage.local.get(API_SETTINGS_KEY);
  return normalizeApiSettings(record[API_SETTINGS_KEY]);
}

export async function readStoredApiConfig(): Promise<ApiConfig> {
  return rankedProfiles(await readStoredApiSettings())[0]?.config ?? emptyApiConfig();
}

export async function selectApiProfile(images = false, id?: string): Promise<ApiProfile> {
  const settings = await readStoredApiSettings();
  const candidates = id ? settings.profiles.filter(p => p.id === id) : rankedProfiles(settings, images);
  for (const profile of candidates) {
    try { validateApiConfig(profile.config); } catch { continue; }
    if (await chrome.permissions.contains({ origins: [apiOrigin(profile.config.endpoint)] })) return profile;
  }
  throw new Error(images ? '没有已启用且已授权的图片模型，请检查模型设置。' : '没有可用模型，请启用模型并授权其 API 域名。');
}

export async function requireApiConfig(images = false, id?: string): Promise<ApiConfig> {
  const { config } = await selectApiProfile(images, id);
  validateApiConfig(config);
  const granted = await chrome.permissions.contains({ origins: [apiOrigin(config.endpoint)] });
  if (!granted) throw new Error('尚未授权 API 域名，请前往 API 设置重新保存并授权。');
  return config;
}

export async function readApiStatus(): Promise<ApiStatus> {
  const settings = await readStoredApiSettings();
  const profiles = rankedProfiles(settings);
  if (!profiles.some(p => { try { validateApiConfig(p.config); return true; } catch { return false; } })) {
    return { configured: false, authorized: false, model: '', supportsImages: false, message: '尚未配置 API，请填写完整接口地址、Key 和模型。' };
  }
  const selected = await selectApiProfile().catch(() => undefined);
  const config = (selected ?? profiles[0]).config;
  const authorized = Boolean(selected);
  const images = await selectApiProfile(true).catch(() => undefined);
  return {
    configured: true,
    authorized,
    model: config.model,
    supportsImages: Boolean(images), profileName: (selected ?? profiles[0]).name, enabledCount: profiles.length,
    message: authorized ? `按优先级使用「${selected!.name}」；图片题选择支持图片的模型。` : 'API 域名尚未授权，请前往设置重新保存并授权。',
  };
}

async function storeSettings(settings: ApiSettings): Promise<void> {
  validateApiSettings(settings);
  for (const origin of apiSettingsOrigins(settings)) {
    if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('请先授权模型列表中的 API 域名。');
  }
  const previous = await readStoredApiSettings();
  await chrome.storage.local.set({ [API_SETTINGS_KEY]: settings });
  const retained = new Set(apiSettingsOrigins(settings));
  for (const p of previous.profiles) {
    try { if (!retained.has(apiOrigin(p.config.endpoint))) await releaseApiOrigin(p.config.endpoint); }
    catch { /* Shared/required permissions do not invalidate a saved configuration. */ }
  }
}

let testing = false;
let activeTest: AbortController | undefined;
let configWrites = 0;
let mutationTail = Promise.resolve();

/** Serialize API saves and joint restores, and cancel a test before it can use stale credentials. */
export function withApiConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  configWrites += 1;
  activeTest?.abort();
  const result = mutationTail.then(operation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result.finally(() => { configWrites -= 1; });
}

export const apiSettingsRoutes: BackgroundRoutes = {
  'toolbox:api:status': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: async () => readApiStatus() },
  'toolbox:api:read': { access: 'options', handle: async () => readStoredApiConfig() },
  'toolbox:api:profiles': { access: 'options', handle: async () => readStoredApiSettings() },
  'toolbox:api:profiles-save': { access: 'options', handle: async message => withApiConfigMutation(async () => {
    validateApiSettings(message.settings);
    await storeSettings(normalizeApiSettings(message.settings));
  }) },
  'toolbox:api:save': { access: 'options', handle: async (message) => withApiConfigMutation(async () => {
    if (!message.config || typeof message.config !== 'object') throw new Error('无效的 API 设置。');
    const config = normalizeApiConfig(message.config);
    validateApiConfig(config);
    if (!await chrome.permissions.contains({ origins: [apiOrigin(config.endpoint)] })) throw new Error('请先授权填写的 API 域名。');
    await privateStorageReady;
    const settings = await readStoredApiSettings();
    const profile = rankedProfiles(settings)[0] ?? settings.profiles[0];
    if (profile) profile.config = config;
    else settings.profiles.push({ id: 'legacy', name: '原有模型', priority: 1, enabled: true, config });
    await storeSettings(settings);
  }) },
  'toolbox:api:clear': { access: 'options', handle: async () => withApiConfigMutation(async () => {
    await privateStorageReady;
    await storeSettings(emptyApiSettings());
  }) },
  'toolbox:api:test': { access: 'options', handle: async message => {
    if (testing) throw new Error('正在检查连接，请稍候。');
    if (configWrites) throw new Error('正在恢复或保存配置，请完成后再测试连接。');
    testing = true;
    const abort = new AbortController();
    activeTest = abort;
    const started = Date.now();
    try {
      if (message.profileId !== undefined && typeof message.profileId !== 'string') throw new Error('模型标识无效。');
      const config = await requireApiConfig(false, message.profileId as string | undefined);
      if (abort.signal.aborted) throw new Error('配置已更改，连接测试已取消。');
      // Active-task extension API calls keep this explicit short check alive.
      const keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => undefined); }, 15000);
      try {
        await waitForProvider('ai', abort.signal);
        await requestChatCompletion(config, [
          { role: 'system', content: '你正在进行 API 连通性检查，请简短回答。' },
          { role: 'user', content: '请只回复：连接成功。' },
        ], abort.signal);
        return { message: '连接成功，模型已返回正文。', latencyMs: Date.now() - started };
      } finally { clearInterval(keepAlive); }
    } finally { testing = false; if (activeTest === abort) activeTest = undefined; }
  } },
};

export function subscribeStoredApi(): void {
  const changed = () => { void broadcastPublic({ type: 'toolbox:api:changed' }, ['chaoxing', 'zjooc']); };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[API_SETTINGS_KEY] || changes[QUESTION_BANK_SETTINGS_KEY] || changes[PACING_SETTINGS_KEY])) activeTest?.abort();
    if (area === 'local' && changes[API_SETTINGS_KEY]) changed();
  });
  chrome.permissions.onRemoved.addListener(() => { activeTest?.abort(); changed(); });
  chrome.permissions.onAdded.addListener(changed);
}
