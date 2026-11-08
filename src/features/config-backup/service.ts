import { API_SETTINGS_KEY, normalizeApiSettings, validateApiSettings, apiSettingsOrigins, apiOrigin } from '../api-settings/types';
import { QUESTION_BANK_SETTINGS_KEY, QUESTION_BANK_ORIGIN, normalizeQuestionBankConfig, validateQuestionBankConfig } from '../question-bank/types';
import { BACKUP_FORMAT, backupOrigins, validateConfigBackup, type ConfigBackup } from './format';

interface BackupDependencies {
  read(): Promise<Record<string, unknown>>;
  write(values: Record<string, unknown>): Promise<void>;
  authorized(origins: string[]): Promise<boolean>;
  release(origin: string): Promise<void>;
  now?(): Date;
}

export function createConfigBackupService(deps: BackupDependencies) {
  return {
    async export(): Promise<ConfigBackup> {
      const record = await deps.read();
      const api = normalizeApiSettings(record[API_SETTINGS_KEY]);
      const questionBank = normalizeQuestionBankConfig(record[QUESTION_BANK_SETTINGS_KEY]);
      const backup: ConfigBackup = { format: BACKUP_FORMAT, version: 1, exportedAt: (deps.now?.() ?? new Date()).toISOString() };
      if (api.profiles.length) {
        try { validateApiSettings(api); } catch { throw new Error('已保存的 API 配置不完整，请先检查后重新导出。'); }
        if ((record[API_SETTINGS_KEY] as { version?: number })?.version === 2) { backup.version = 2; backup.apiProfiles = api; }
        else backup.api = api.profiles[0].config;
      }
      if (questionBank.token) {
        try { validateQuestionBankConfig(questionBank); } catch { throw new Error('已保存的题库配置无效，请先检查后重新导出。'); }
        backup.questionBank = questionBank;
      }
      if (!backup.api && !backup.apiProfiles && !backup.questionBank) throw new Error('尚无已保存的 API 或言溪题库配置可以导出。');
      return backup;
    },
    async restore(value: unknown): Promise<void> {
      const backup = validateConfigBackup(value);
      if (!await deps.authorized(backupOrigins(backup))) throw new Error('未获得备份所需的域名权限，已有配置未修改。');
      const previous = await deps.read();
      const values: Record<string, unknown> = {};
      if (backup.api) values[API_SETTINGS_KEY] = backup.api;
      if (backup.apiProfiles) values[API_SETTINGS_KEY] = backup.apiProfiles;
      if (backup.questionBank) values[QUESTION_BANK_SETTINGS_KEY] = backup.questionBank;
      await deps.write(values);
      if (!backup.api && !backup.apiProfiles) return;
      // Permissions may be shared with the bank. Release only after the full restore commits.
      const oldApi = normalizeApiSettings(previous[API_SETTINGS_KEY]);
      const bank = backup.questionBank ?? normalizeQuestionBankConfig(previous[QUESTION_BANK_SETTINGS_KEY]);
      try {
        const retained = new Set(apiSettingsOrigins(normalizeApiSettings(backup.apiProfiles ?? backup.api)));
        for (const p of oldApi.profiles) {
          const oldOrigin = apiOrigin(p.config.endpoint);
          if (!retained.has(oldOrigin) && !(bank.token && oldOrigin === QUESTION_BANK_ORIGIN)) await deps.release(oldOrigin);
        }
      } catch { /* A stale or shared permission never invalidates a successful restore. */ }
    },
  };
}
