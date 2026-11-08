import { type BackgroundRoutes } from '../../core/background-context';
import { readZjoocRoute } from './adapters/page';
import type { ZjoocStudySession } from './types';

const prefix = (tabId: number) => `zjooc-study.session.${tabId}.`;
const key = (tabId: number, courseKey: string) => `${prefix(tabId)}${courseKey}`;

function authorizedCourse(sender: chrome.runtime.MessageSender): string {
  const route = readZjoocRoute(sender.url ?? '');
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || !route) throw new Error('仅浙学课程学习页可访问运行状态。');
  return route.courseKey;
}

function isSession(value: unknown): value is ZjoocStudySession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<ZjoocStudySession>;
  const index = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000;
  const id = (value: unknown) => typeof value === 'string' && /^[a-f\d]{32}$/.test(value);
  return id(session.courseKey) && typeof session.paused === 'boolean'
    && (session.start === undefined || Boolean(session.start && index(session.start.chapterIndex) && id(session.start.resourceId)
      && typeof session.start.chapterKey === 'string' && session.start.chapterKey.length > 0 && session.start.chapterKey.length <= 2000))
    && (session.cursor === undefined || Boolean(session.cursor && index(session.cursor.chapterIndex) && (session.cursor.resourceId === undefined || id(session.cursor.resourceId))))
    && (session.processed === undefined || (Array.isArray(session.processed) && session.processed.length <= 10000
      && session.processed.every(item => item && id(item.resourceId) && index(item.chapterIndex)
        && ((item.kind === 'video' && item.outcome === 'ended' && item.refreshed === undefined)
          || (item.kind === 'courseware' && item.outcome === 'submitted' && (item.refreshed === undefined || typeof item.refreshed === 'boolean'))))));
}

function publicSession(session: ZjoocStudySession): ZjoocStudySession {
  return { courseKey: session.courseKey, paused: session.paused,
    ...(session.start ? { start: { chapterIndex: session.start.chapterIndex, chapterKey: session.start.chapterKey, resourceId: session.start.resourceId } } : {}),
    ...(session.cursor ? { cursor: { chapterIndex: session.cursor.chapterIndex, ...(session.cursor.resourceId ? { resourceId: session.cursor.resourceId } : {}) } } : {}),
    ...(session.processed ? { processed: session.processed.map(item => ({ resourceId: item.resourceId, chapterIndex: item.chapterIndex, kind: item.kind, outcome: item.outcome,
      ...(item.refreshed !== undefined ? { refreshed: item.refreshed } : {}) })) } : {}) };
}

export const zjoocStudyRoutes: BackgroundRoutes = {
  'toolbox:zjooc-study:session:read': { access: 'top-page', platforms: ['zjooc'], handle: async (message, sender) => {
    const courseKey = authorizedCourse(sender);
    if (message.courseKey !== courseKey) throw new Error('运行状态不属于当前课程。');
    const sessionKey = key(sender.tab!.id!, courseKey);
    const session = (await chrome.storage.session.get(sessionKey))[sessionKey];
    return isSession(session) && session.courseKey === courseKey ? publicSession(session) : undefined;
  } },
  'toolbox:zjooc-study:session:write': { access: 'top-page', platforms: ['zjooc'], handle: async (message, sender) => {
    const courseKey = authorizedCourse(sender);
    if (!isSession(message.session) || message.session.courseKey !== courseKey) throw new Error('无效的浙学运行状态。');
    await chrome.storage.session.set({ [key(sender.tab!.id!, courseKey)]: publicSession(message.session) });
  } },
};

export function installZjoocStudyBackground(): void {
  chrome.tabs.onRemoved.addListener(tabId => {
    void chrome.storage.session.get(null).then(stored => chrome.storage.session.remove(Object.keys(stored).filter(value => value.startsWith(prefix(tabId))))).catch(() => undefined);
  });
}
