import { apiOrigin, apiSettingsOrigins, normalizeApiConfig, validateApiConfig, normalizeApiSettings, validateApiSettings, type ApiConfig, type ApiSettings } from '../api-settings/types';
import { QUESTION_BANK_ORIGIN, normalizeQuestionBankConfig, validateQuestionBankConfig, type QuestionBankConfig } from '../question-bank/types';

export const BACKUP_FORMAT = 'chaoxing-edge-toolbox-config';
export const BACKUP_MAX_BYTES = 131072;
export interface ConfigBackup {
  format: typeof BACKUP_FORMAT;
  version: 1 | 2;
  exportedAt: string;
  api?: ApiConfig;
  apiProfiles?: ApiSettings;
  questionBank?: QuestionBankConfig;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const invalid = () => new Error('备份格式或配置无效，请选择本插件导出的完整 JSON 文件。');

/** Validate before normalization: malformed credentials must never become empty/default config. */
export function validateConfigBackup(value: unknown): ConfigBackup {
  if (!object(value) || value.format !== BACKUP_FORMAT || (value.version !== 1 && value.version !== 2)
      || !only(value, ['format', 'version', 'exportedAt', 'api', 'apiProfiles', 'questionBank'])
      || typeof value.exportedAt !== 'string' || value.exportedAt.length > 40 || !Number.isFinite(Date.parse(value.exportedAt))) throw invalid();
  const backup: ConfigBackup = { format: BACKUP_FORMAT, version: value.version as 1 | 2, exportedAt: value.exportedAt };
  if (Object.hasOwn(value, 'apiProfiles')) {
    if (value.version !== 2 || Object.hasOwn(value, 'api')) throw invalid();
    try { validateApiSettings(value.apiProfiles); backup.apiProfiles = normalizeApiSettings(value.apiProfiles); } catch { throw invalid(); }
  }
  if (Object.hasOwn(value, 'api')) {
    const api = value.api;
    if (!object(api) || api.version !== 1 || !only(api, ['version', 'endpoint', 'apiKey', 'model', 'stream', 'supportsImages'])
        || typeof api.endpoint !== 'string' || typeof api.apiKey !== 'string' || typeof api.model !== 'string'
        || typeof api.stream !== 'boolean' || (api.supportsImages !== undefined && typeof api.supportsImages !== 'boolean')) throw invalid();
    backup.api = normalizeApiConfig(api);
    try { validateApiConfig(backup.api); } catch { throw invalid(); }
  }
  if (Object.hasOwn(value, 'questionBank')) {
    const bank = value.questionBank;
    if (!object(bank) || bank.version !== 1 || typeof bank.token !== 'string' || !only(bank, ['version', 'token'])) throw invalid();
    backup.questionBank = normalizeQuestionBankConfig(bank);
    try { validateQuestionBankConfig(backup.questionBank); } catch { throw invalid(); }
  }
  if (!backup.api && !backup.apiProfiles?.profiles.length && !backup.questionBank) throw new Error('备份未包含可恢复的 API 或言溪题库配置。');
  return backup;
}

export function parseConfigBackup(text: string): ConfigBackup {
  if (text.length > BACKUP_MAX_BYTES) throw new Error('备份文件过大，请选择本插件导出的配置文件。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  return validateConfigBackup(value);
}

export function backupOrigins(backup: ConfigBackup): string[] {
  return [...new Set([...(backup.api ? [apiOrigin(backup.api.endpoint)] : []), ...(backup.apiProfiles ? apiSettingsOrigins(backup.apiProfiles) : []), ...(backup.questionBank ? [QUESTION_BANK_ORIGIN] : [])])];
}
