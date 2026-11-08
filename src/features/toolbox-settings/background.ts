import { broadcastPublic, isExtensionPage, senderPlatform, privateStorageReady, type BackgroundRoutes } from '../../core/background-context';
import { FEATURES, isFeatureId, isFeatureSupported } from '../catalog';
import { normalizeSettings, SETTINGS_KEY, type Settings } from '../../shared/settings';
import { isZjoocPlaybackRate } from '../zjooc-study/playback-rate';
import { isZjoocStartMode } from '../zjooc-study/start-position';

export const SETTINGS_READ = 'toolbox:settings:read';
export const SETTINGS_WRITE = 'toolbox:settings:write';
export const SETTINGS_CHANGED = 'toolbox:settings:changed';
let writes = Promise.resolve();

export async function readStoredSettings(): Promise<Settings> {
  await privateStorageReady;
  const record = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(record[SETTINGS_KEY]);
}

export const settingsRoutes: BackgroundRoutes = {
  [SETTINGS_READ]: { access: 'public', handle: async () => readStoredSettings() },
  [SETTINGS_WRITE]: { access: 'public', handle: async (message, sender) => {
    const input = message.settings;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的功能设置。');
    const value = input as Settings;
    if (value.version !== 1 || typeof value.enabled !== 'boolean' || !value.features
        || Object.entries(value.features).some(([key, enabled]) => !isFeatureId(key) || typeof enabled !== 'boolean')
        || FEATURES.some((feature) => typeof value.features[feature.id] !== 'boolean')
        || (value.zjoocPlaybackRate !== undefined && !isZjoocPlaybackRate(value.zjoocPlaybackRate))
        || (value.zjoocStartMode !== undefined && !isZjoocStartMode(value.zjoocStartMode))) throw new Error('无效的功能设置。');
    const next = normalizeSettings(value);
    const task = writes.then(async () => {
      await privateStorageReady;
      const current = await readStoredSettings();
      // Older v1 clients do not send this field. Preserve their existing preference.
      if (value.zjoocPlaybackRate === undefined) next.zjoocPlaybackRate = current.zjoocPlaybackRate;
      if (value.zjoocStartMode === undefined) next.zjoocStartMode = current.zjoocStartMode;
      if (!isExtensionPage(sender)) {
        const platform = senderPlatform(sender);
        if (platform !== 'zjooc') next.zjoocPlaybackRate = current.zjoocPlaybackRate;
        if (platform !== 'zjooc') next.zjoocStartMode = current.zjoocStartMode;
        for (const feature of FEATURES) {
          if (!isFeatureSupported(feature.id, platform)) next.features[feature.id] = current.features[feature.id];
        }
      }
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    });
    writes = task.catch(() => undefined);
    await task;
    return next;
  } },
};

export function subscribeStoredSettings(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    void broadcastPublic({ type: SETTINGS_CHANGED, settings: normalizeSettings(changes[SETTINGS_KEY].newValue) });
  });
}
