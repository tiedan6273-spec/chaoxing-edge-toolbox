import type { BackgroundRoutes } from '../../core/background-context';
import { readStoredApiConfig, readStoredApiSettings, selectApiProfile } from '../api-settings/background';
import { isQuestionSnapshot } from '../question-answer/protocol';
import { ACTIVITY_SETTINGS, HISTORY_KEY, USAGE_KEY, emptyLedger, modelPricing, type ActivitySettings, type ActivityStatus } from './types';
import { activityTransaction, apiIdentity, readActivitySettings, readLedger } from './usage-background';
import { clearHistory, historyCount, loadHistory } from './history-background';

export async function activityStatus(selectedIdentity?: string): Promise<ActivityStatus> {
  return activityTransaction(async () => {
    const settings = await readActivitySettings();
    const config = (await selectApiProfile().catch(() => undefined))?.config ?? await readStoredApiConfig();
    const profiles = await readStoredApiSettings();
    const models = await Promise.all(profiles.profiles.map(async p => ({ identity: await apiIdentity(p.config), name: p.name, model: p.config.model })));
    const selected = models.find(m => m.identity === selectedIdentity);
    const identity = selected?.identity ?? await apiIdentity(config);
    const pricing = modelPricing(settings, identity);
    return { settings: { ...settings, pricing }, ledger: await readLedger(), model: selected?.model ?? config.model, identity, priced: Boolean(pricing), historyCount: await historyCount(), models };
  });
}
export const activityRoutes: BackgroundRoutes = {
  'toolbox:activity:status': { access: 'public', handle: async message => activityStatus(typeof message.identity === 'string' ? message.identity : undefined) },
  'toolbox:activity:save': { access: 'options', handle: async message => activityTransaction(async () => {
    const v = message.settings as ActivitySettings;
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1_000_000;
    if (!v || ![0, 1, 7, 30].includes(v.retentionDays) || !valid(v.budget)
      || (v.pricing && ![v.pricing.input, v.pricing.cached, v.pricing.output].every(valid))) throw new Error('保留期限、预算或单价无效。');
    if ((await readLedger()).pending.length) throw new Error('请等待正在进行的 AI 请求结束，再修改价格和预算。');
    const config = await readStoredApiConfig();
    // Prevent a settings tab edited for an old model from assigning its prices to a new one.
    const identities = await Promise.all((await readStoredApiSettings()).profiles.map(p => apiIdentity(p.config)));
    if (typeof message.identity !== 'string' || ![...identities, await apiIdentity(config)].includes(message.identity)) throw new Error('接口或模型已变化，请重新读取后再保存价格。');
    const identity = message.identity;
    const current = await readActivitySettings();
    const prices: NonNullable<ActivitySettings['prices']> = {};
    for (const id of identities) { const price = modelPricing(current, id); if (price) prices[id] = price; }
    const pricing = v.pricing ? { identity, input: v.pricing.input, cached: v.pricing.cached, output: v.pricing.output } : undefined;
    if (pricing) prices[identity] = pricing; else delete prices[identity];
    const settings: ActivitySettings = { retentionDays: v.retentionDays, budget: v.budget, prices };
    // Old costs retain their original price; a price change starts a fresh, explicit round.
    const changed = JSON.stringify(pricing) !== JSON.stringify(modelPricing(current, identity));
    const patch: Record<string, unknown> = { [ACTIVITY_SETTINGS]: settings };
    if (changed) patch[USAGE_KEY] = emptyLedger();
    if (!settings.retentionDays) {
      const old = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] as { epoch?: number } | undefined;
      patch[HISTORY_KEY] = { epoch: (old?.epoch ?? 0) + 1, records: [] };
    }
    await chrome.storage.local.set(patch);
  }) },
  'toolbox:activity:identity': { access: 'options', handle: async () => apiIdentity(await readStoredApiConfig()) },
  'toolbox:activity:reset': { access: 'options', handle: async () => activityTransaction(async () => {
    if ((await readLedger()).pending.length) throw new Error('还有 AI 请求进行中，暂不能重置统计。');
    await chrome.storage.local.set({ [USAGE_KEY]: emptyLedger() });
  }) },
  'toolbox:activity:clear': { access: 'options', handle: async () => clearHistory() },
  'toolbox:history:clear': { access: 'top-page', handle: async (_, sender) => clearHistory(sender.url!) },
  'toolbox:history:load': { access: 'top-page', handle: async (message, sender) => {
    if (!Array.isArray(message.questions) || message.questions.length > 300 || !message.questions.every(isQuestionSnapshot)
      || JSON.stringify(message.questions).length > 2_000_000) throw new Error('历史匹配题目无效或超出大小限制。');
    return loadHistory(sender.url!, message.questions);
  } },
};
