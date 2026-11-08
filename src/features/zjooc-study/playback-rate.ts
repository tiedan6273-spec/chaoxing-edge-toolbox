/** "highest" follows the current player's own menu; numeric choices never create a new rate. */
export type ZjoocPlaybackRate = 'highest' | number;

export function isZjoocPlaybackRate(value: unknown): value is ZjoocPlaybackRate {
  return value === 'highest' || (typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 16);
}

export function normalizeZjoocPlaybackRate(value: unknown): ZjoocPlaybackRate {
  return isZjoocPlaybackRate(value) ? value : 'highest';
}

export function preferredPlaybackRate<T extends { rate: number }>(choice: ZjoocPlaybackRate, rates: readonly T[]): T | undefined {
  const available = rates.filter(item => isZjoocPlaybackRate(item.rate));
  return choice === 'highest' ? available.reduce<T | undefined>((best, item) => !best || item.rate > best.rate ? item : best, undefined)
    : available.find(item => Math.abs(item.rate - choice) < 0.001);
}
