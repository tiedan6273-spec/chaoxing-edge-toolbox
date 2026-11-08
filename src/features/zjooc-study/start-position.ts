import { isZjoocLoading, readZjoocChapters, readZjoocResources, readZjoocRoute } from './adapters/page';

export type ZjoocStartMode = 'first-unfinished' | 'current-forward';

export interface ZjoocStartPosition {
  chapterIndex: number;
  chapterKey: string;
  resourceId: string;
}

export function isZjoocStartMode(value: unknown): value is ZjoocStartMode {
  return value === 'first-unfinished' || value === 'current-forward';
}

export function normalizeZjoocStartMode(value: unknown): ZjoocStartMode {
  return isZjoocStartMode(value) ? value : 'first-unfinished';
}

/** A loading page or stale sidebar is not a usable start position. */
export function readCurrentStartPosition(doc: Document): ZjoocStartPosition | undefined {
  const route = readZjoocRoute(doc.location.href);
  if (!route || isZjoocLoading(doc)) return undefined;
  const chapters = readZjoocChapters(doc);
  const activeChapters = chapters.filter(item => item.active);
  const resources = readZjoocResources(doc).filter(item => item.active);
  if (activeChapters.length !== 1 || resources.length !== 1 || resources[0].id !== route.chapterId) return undefined;
  return { chapterIndex: chapters.indexOf(activeChapters[0]), chapterKey: activeChapters[0].key, resourceId: resources[0].id };
}
