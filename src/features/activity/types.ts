export const ACTIVITY_SETTINGS = 'toolbox.activity.settings.v1';
export const USAGE_KEY = 'toolbox.activity.usage.v1';
export const HISTORY_KEY = 'toolbox.activity.history.v1';
export interface TokenUsage { input: number; output: number; cached: number; reasoning: number }
export interface ActivitySettings {
  retentionDays: 0 | 1 | 7 | 30;
  pricing?: { identity: string; input: number; cached: number; output: number };
  prices?: Record<string, NonNullable<ActivitySettings['pricing']>>;
  budget: number;
}
export interface UsageLedger {
  since: number; requests: number; input: number; output: number; cached: number; reasoning: number;
  cost: number; unknown: number; pending: string[];
}
export const emptyLedger = (): UsageLedger => ({ since: Date.now(), requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, cost: 0, unknown: 0, pending: [] });
export const defaultActivitySettings = (): ActivitySettings => ({ retentionDays: 7, budget: 0 });
export interface ActivityStatus { settings: ActivitySettings; ledger: UsageLedger; model: string; identity: string; priced: boolean; historyCount: number;
  models?: { identity: string; model: string; name: string }[] }
export function modelPricing(settings: ActivitySettings, identity: string): ActivitySettings['pricing'] {
  return settings.prices?.[identity] ?? (settings.pricing?.identity === identity ? settings.pricing : undefined);
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), item => item.toString(16).padStart(2, '0')).join('');
}
export function readUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  const number = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= 1_000_000_000;
  if (!number(v.prompt_tokens) || !number(v.completion_tokens)) return;
  const details = v.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const output = v.completion_tokens_details as { reasoning_tokens?: unknown } | undefined;
  const cached = v.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0;
  const reasoning = output?.reasoning_tokens ?? 0;
  if (!number(cached) || !number(reasoning) || cached > v.prompt_tokens || reasoning > v.completion_tokens) return;
  return { input: v.prompt_tokens, output: v.completion_tokens, cached, reasoning };
}
export function usageCost(usage: TokenUsage, pricing: NonNullable<ActivitySettings['pricing']>): number {
  // Reasoning is already included in output; cache hits are part of input.
  return ((usage.input - usage.cached) * pricing.input + usage.cached * pricing.cached + usage.output * pricing.output) / 1_000_000;
}
export function budgetReason(settings: ActivitySettings, ledger: UsageLedger, priced: boolean): string | undefined {
  if (settings.budget <= 0) return;
  if (!priced) return '预算已开启，请先为当前接口和模型保存价格。';
  if (ledger.unknown) return '本轮有费用未知的请求，已暂停后续 AI 请求；请核对账单后在设置中开始新一轮统计。';
  if (ledger.pending.length) return '预算开启时每次仅允许一个 AI 请求，请等待其他页面的请求结束。';
  if (ledger.cost >= settings.budget) return '本轮预计费用已达到预算，已暂停后续 AI 请求。';
}
