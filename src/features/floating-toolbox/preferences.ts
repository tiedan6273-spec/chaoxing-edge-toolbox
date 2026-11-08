export const LEGACY_UI_SETTINGS_KEY = 'toolbox.ui.v1';
export const UI_SETTINGS_KEY = 'toolbox.ui.v2';
export type ToolboxView = 'page-tools' | 'answer' | 'chapter-study' | 'zjooc-study' | 'zjooc-exam';
export type ToolboxViewRequest = ToolboxView | 'question-extract' | 'ai-answer';

/** Keep old open-panel callers working without coupling workspace IDs to features. */
export function normalizeToolboxView(value: unknown): ToolboxView | undefined {
  if (value === 'page-tools' || value === 'question-extract') return 'page-tools';
  if (value === 'answer' || value === 'ai-answer') return 'answer';
  if (value === 'chapter-study') return 'chapter-study';
  if (value === 'zjooc-study') return 'zjooc-study';
  if (value === 'zjooc-exam') return 'zjooc-exam';
  return undefined;
}

export interface UiPreferences {
  version: 2;
  x: number;
  y: number;
  minimized: boolean;
  /** Missing in older v2 records; false keeps the regular toolbar visible. */
  hidden?: boolean;
}

export function defaultUiPreferences(): UiPreferences {
  return { version: 2, x: 1, y: 0.12, minimized: true };
}

export function normalizeUiPreferences(value: unknown): UiPreferences {
  const result = defaultUiPreferences();
  if (!value || typeof value !== 'object') return result;
  const input = value as Partial<UiPreferences>;
  for (const key of ['x', 'y'] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) result[key] = Math.max(0, Math.min(1, input[key]));
  }
  if (typeof input.minimized === 'boolean') result.minimized = input.minimized;
  if (typeof input.hidden === 'boolean') result.hidden = input.hidden;
  return result;
}

export interface LegacyUiPreferences {
  version: 1;
  x: number;
  y: number;
  minimized: boolean;
}

export function normalizeLegacyUiPreferences(value: unknown): LegacyUiPreferences {
  const { x, y, minimized } = normalizeUiPreferences(value);
  return { version: 1, x, y, minimized };
}

export interface UiSnapshot {
  preferences: UiPreferences;
  revision: number;
  resetRevision: number;
  sourceId: string;
  operationId: number;
  reason: 'update' | 'reset';
  legacy?: LegacyUiPreferences;
}

export interface UiPreferencePatch {
  position?: { x: number; y: number };
  minimized?: boolean;
  hidden?: boolean;
}

export interface UiUpdate {
  sourceId: string;
  operationId: number;
  baseRevision: number;
  patch?: UiPreferencePatch;
  reset?: 'position' | 'all';
}

export interface UiWriteResult {
  applied: boolean;
  snapshot: UiSnapshot;
}

export function defaultUiSnapshot(): UiSnapshot {
  return { preferences: defaultUiPreferences(), revision: 0, resetRevision: 0, sourceId: '', operationId: 0, reason: 'update' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Invalid v2 records must fall back to v1 instead of looking like saved defaults. */
export function isUiSnapshot(value: unknown): value is UiSnapshot {
  if (!isRecord(value) || !isRecord(value.preferences)) return false;
  const preferences = value.preferences;
  if (preferences.version !== 2 || typeof preferences.minimized !== 'boolean'
      || (preferences.hidden !== undefined && typeof preferences.hidden !== 'boolean')
      || !isCoordinate(preferences.x) || !isCoordinate(preferences.y)
      || preferences.x < 0 || preferences.x > 1 || preferences.y < 0 || preferences.y > 1) return false;
  return isRevision(value.revision) && isRevision(value.resetRevision) && value.resetRevision <= value.revision
    && (value.reason === 'update' || value.reason === 'reset')
    && ((value.revision === 0 && value.sourceId === '' && value.operationId === 0)
      || (isSourceId(value.sourceId) && isRevision(value.operationId) && value.operationId > 0));
}

/** Copy only public fields, including when storage or an RPC contains extra keys. */
export function copyUiSnapshot(snapshot: UiSnapshot): UiSnapshot {
  return {
    preferences: normalizeUiPreferences(snapshot.preferences),
    revision: snapshot.revision,
    resetRevision: snapshot.resetRevision,
    sourceId: snapshot.sourceId,
    operationId: snapshot.operationId,
    reason: snapshot.reason,
    ...(snapshot.legacy ? { legacy: normalizeLegacyUiPreferences(snapshot.legacy) } : {}),
  };
}

function readPosition(value: unknown): { x: number; y: number } {
  if (!isRecord(value) || !isCoordinate(value.x) || !isCoordinate(value.y)) throw new Error('无效的悬浮框位置。');
  return { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) };
}

function validateUpdate(value: unknown, allowReset: boolean): UiUpdate {
  if (!isRecord(value) || !isSourceId(value.sourceId) || !isRevision(value.operationId) || value.operationId === 0
      || !isRevision(value.baseRevision)) throw new Error('无效的悬浮框操作。');
  if (value.reset !== undefined) {
    if (!allowReset || (value.reset !== 'position' && value.reset !== 'all')
        || (value.patch !== undefined && (value.reset !== 'position' || !isRecord(value.patch)
          || value.patch.minimized !== undefined || value.patch.hidden !== undefined || value.patch.position === undefined))) {
      throw new Error('无效的悬浮框复位操作。');
    }
    const position = isRecord(value.patch) ? readPosition(value.patch.position) : undefined;
    return { sourceId: value.sourceId, operationId: value.operationId, baseRevision: value.baseRevision, reset: value.reset,
      ...(position ? { patch: { position } } : {}),
    };
  }
  if (allowReset || !isRecord(value.patch)) throw new Error('无效的悬浮框设置。');
  const patch = value.patch;
  const next: UiPreferencePatch = {};
  if (patch.position !== undefined) {
    next.position = readPosition(patch.position);
  }
  if (patch.minimized !== undefined) {
    if (typeof patch.minimized !== 'boolean') throw new Error('无效的悬浮框显示状态。');
    next.minimized = patch.minimized;
  }
  if (patch.hidden !== undefined) {
    if (typeof patch.hidden !== 'boolean') throw new Error('无效的悬浮框隐藏状态。');
    next.hidden = patch.hidden;
  }
  if (!next.position && next.minimized === undefined && next.hidden === undefined) throw new Error('悬浮框操作没有可保存的设置。');
  return { sourceId: value.sourceId, operationId: value.operationId, baseRevision: value.baseRevision, patch: next };
}

export interface UiPreferenceStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

/** The background owns one store. No listeners or browser APIs are installed here. */
export function createUiPreferenceStore(storage: UiPreferenceStorage) {
  let pending = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async function readStored(): Promise<UiSnapshot> {
    const record = await storage.get([UI_SETTINGS_KEY, LEGACY_UI_SETTINGS_KEY]);
    if (isUiSnapshot(record[UI_SETTINGS_KEY])) return copyUiSnapshot(record[UI_SETTINGS_KEY]);
    const snapshot = defaultUiSnapshot();
    if (isRecord(record[LEGACY_UI_SETTINGS_KEY])) {
      snapshot.legacy = normalizeLegacyUiPreferences(record[LEGACY_UI_SETTINGS_KEY]);
      snapshot.preferences = normalizeUiPreferences(snapshot.legacy);
    }
    return snapshot;
  }
  function update(value: unknown, allowReset: boolean): Promise<UiWriteResult> {
    return serialize(async () => {
      const operation = validateUpdate(value, allowReset);
      const current = await readStored();
      if (current.sourceId === operation.sourceId && current.operationId === operation.operationId) {
        return { applied: true, snapshot: current };
      }
      if (!operation.reset && operation.baseRevision < current.resetRevision) return { applied: false, snapshot: current };
      const preferences = operation.reset === 'all' ? defaultUiPreferences() : { ...current.preferences };
      if (operation.reset === 'position') {
        const defaults = defaultUiPreferences();
        preferences.x = operation.patch?.position?.x ?? defaults.x;
        preferences.y = operation.patch?.position?.y ?? defaults.y;
      } else if (operation.patch) {
        if (operation.patch.position) Object.assign(preferences, operation.patch.position);
        if (operation.patch.minimized !== undefined) preferences.minimized = operation.patch.minimized;
        if (operation.patch.hidden !== undefined) preferences.hidden = operation.patch.hidden;
      }
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('悬浮框设置版本超出范围。');
      const snapshot: UiSnapshot = {
        preferences,
        revision,
        resetRevision: operation.reset ? revision : current.resetRevision,
        sourceId: operation.sourceId,
        operationId: operation.operationId,
        reason: operation.reset ? 'reset' : 'update',
        ...(!operation.reset && !operation.patch?.position && current.legacy ? { legacy: current.legacy } : {}),
      };
      await storage.set({ [UI_SETTINGS_KEY]: snapshot });
      return { applied: true, snapshot: copyUiSnapshot(snapshot) };
    });
  }
  return {
    read: () => serialize(readStored),
    write: (value: unknown) => update(value, false),
    reset: (value: unknown) => update(value, true),
  };
}
