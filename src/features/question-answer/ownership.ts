import { assessmentSceneFromUrl } from '../../platform/assessment-routes';

export function assessmentResourceKey(value?: string): string | undefined {
  if (!value || !assessmentSceneFromUrl(value)) return undefined;
  const url = new URL(value);
  // In-page question anchors are not separate papers. Hash routes are retained.
  if (!url.hash.startsWith('#/')) url.hash = '';
  url.searchParams.sort();
  return url.href;
}

/** A task keeps its paper until cancellation is acknowledged or its frame leaves. */
export function createAnswerOwnership<Owner>() {
  const owners = new Map<string, Owner>();
  return {
    claim(key: string | undefined, owner: Owner): void {
      if (!key) return;
      const existing = owners.get(key);
      if (existing !== undefined && existing !== owner) throw new Error('另一标签页正在处理这份试卷，请先在该页暂停或关闭后重试。');
      owners.set(key, owner);
    },
    release(owner: Owner): void {
      for (const [key, value] of owners) if (value === owner) owners.delete(key);
    },
  };
}
