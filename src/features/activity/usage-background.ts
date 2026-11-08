import { privateStorageReady } from '../../core/background-context';
import type { ApiConfig } from '../api-settings/types';
import { ACTIVITY_SETTINGS, USAGE_KEY, defaultActivitySettings, emptyLedger, digest, budgetReason, usageCost, modelPricing, type ActivitySettings, type TokenUsage, type UsageLedger } from './types';

let tail = Promise.resolve();
const active = new Set<string>();
export class UsageBudgetError extends Error {}
export function activityTransaction<T>(action: () => Promise<T>): Promise<T> {
  const result = tail.then(action); tail = result.then(() => undefined, () => undefined); return result;
}
export const apiIdentity = (config: Pick<ApiConfig, 'endpoint' | 'model'>): Promise<string> => digest([config.endpoint, config.model]);
export async function readActivitySettings(): Promise<ActivitySettings> {
  await privateStorageReady;
  const data = await chrome.storage.local.get(ACTIVITY_SETTINGS);
  return (data[ACTIVITY_SETTINGS] as ActivitySettings | undefined) ?? defaultActivitySettings();
}
export async function readLedger(): Promise<UsageLedger> {
  await privateStorageReady;
  const data = await chrome.storage.local.get(USAGE_KEY);
  const ledger = (data[USAGE_KEY] as UsageLedger | undefined) ?? emptyLedger();
  const orphaned = ledger.pending.filter(id => !active.has(id));
  if (orphaned.length) {
    ledger.unknown += orphaned.length;
    ledger.pending = ledger.pending.filter(id => active.has(id));
    await chrome.storage.local.set({ [USAGE_KEY]: ledger });
  }
  return ledger;
}
export async function beginUsage(config: ApiConfig): Promise<{ id: string; pricing?: ActivitySettings['pricing'] }> {
  return activityTransaction(async () => {
    const settings = await readActivitySettings();
    const ledger = await readLedger();
    const pricing = modelPricing(settings, await apiIdentity(config));
    const reason = budgetReason(settings, ledger, Boolean(pricing));
    if (reason) throw new UsageBudgetError(reason);
    const id = crypto.randomUUID();
    ledger.requests++; ledger.pending.push(id); active.add(id);
    try { await chrome.storage.local.set({ [USAGE_KEY]: ledger }); }
    catch (error) { active.delete(id); throw error; }
    return { id, pricing };
  });
}
export async function finishUsage(ticket: Awaited<ReturnType<typeof beginUsage>>, usage?: TokenUsage): Promise<void> {
  try { await activityTransaction(async () => {
    const ledger = await readLedger();
    if (!ledger.pending.includes(ticket.id)) return;
    ledger.pending = ledger.pending.filter(id => id !== ticket.id);
    if (usage) {
      ledger.input += usage.input; ledger.output += usage.output; ledger.cached += usage.cached; ledger.reasoning += usage.reasoning;
    }
    if (usage && ticket.pricing) ledger.cost += usageCost(usage, ticket.pricing);
    else ledger.unknown++;
    await chrome.storage.local.set({ [USAGE_KEY]: ledger });
  }); } finally { active.delete(ticket.id); }
}
