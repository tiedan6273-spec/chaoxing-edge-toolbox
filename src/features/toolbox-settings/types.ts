import { FEATURES, type FeatureId } from '../catalog';
import { normalizeZjoocPlaybackRate, type ZjoocPlaybackRate } from '../zjooc-study/playback-rate';
import { normalizeZjoocStartMode, type ZjoocStartMode } from '../zjooc-study/start-position';

export const SETTINGS_KEY = 'toolbox.settings.v1';

export interface Settings {
  version: 1;
  enabled: boolean;
  features: Record<FeatureId, boolean>;
  zjoocPlaybackRate: ZjoocPlaybackRate;
  zjoocStartMode: ZjoocStartMode;
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    enabled: true,
    features: Object.fromEntries(FEATURES.map((feature) => [feature.id, feature.defaultEnabled])) as Settings['features'],
    zjoocPlaybackRate: 'highest',
    zjoocStartMode: 'first-unfinished',
  };
}

/** Recover known public preferences. Each call creates independent mutable data. */
export function normalizeSettings(value: unknown): Settings {
  const result = defaultSettings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Partial<Settings>;
  // An unknown future version must not silently enable page behavior.
  if (input.version !== undefined && input.version !== 1) return { ...result, enabled: false };
  if (typeof input.enabled === 'boolean') result.enabled = input.enabled;
  result.zjoocPlaybackRate = normalizeZjoocPlaybackRate(input.zjoocPlaybackRate);
  result.zjoocStartMode = normalizeZjoocStartMode(input.zjoocStartMode);
  if (input.features && typeof input.features === 'object') {
    for (const feature of FEATURES) {
      if (typeof input.features[feature.id] === 'boolean') result.features[feature.id] = input.features[feature.id];
    }
  }
  return result;
}

export function isFeatureEnabled(settings: Settings, id: FeatureId): boolean {
  return settings.enabled && settings.features[id];
}
