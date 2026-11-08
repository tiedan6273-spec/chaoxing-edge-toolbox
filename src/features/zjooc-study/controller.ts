import {
  completionButton, coursewareButton, coursewareButtonSubmitted, coursewareReadiness, coursewareSubmissionBusy, hasCoursewareFailure, isVisible, isZjoocLoading, readPlaybackRates, readZjoocChapters, readZjoocResources,
  readZjoocRoute, resourcePane, showPlaybackMenu, type ZjoocResource,
} from './adapters/page';
import type { ZjoocStudyController, ZjoocStudyProcessed, ZjoocStudyRuntime, ZjoocStudySession, ZjoocStudyState } from './types';
import { isZjoocPlaybackRate, preferredPlaybackRate, type ZjoocPlaybackRate } from './playback-rate';
import { readCurrentStartPosition, type ZjoocStartMode } from './start-position';

interface Timing { poll: number; settle: number; load: number; confirmation: number; refreshDelay: number; retry: number; maxRetry: number }
export interface ZjoocStudyDependencies {
  document: Document;
  isEnabled(): boolean;
  getPlaybackRate?(): ZjoocPlaybackRate;
  getStartMode?(): ZjoocStartMode;
  runtime: ZjoocStudyRuntime;
  /** Reload the current document; injectable so isolated tests can recreate the controller. */
  reload?(): void;
  /** Dependency override for deterministic local tests; never exposed as a user preference. */
  timing?: Partial<Timing>;
}
interface Worker {
  abort: AbortController;
  courseKey: string;
  chapterId: string;
  chapterKey: string;
  resourceId?: string;
  transitioning: boolean;
  media?: HTMLVideoElement;
  recovery?: { media: HTMLVideoElement; position: number };
  refreshingResource?: string;
  preparingResource?: string;
  chapterIndex: number;
}
class Attention extends Error {}
class ManualNavigation extends Error {}
class ContentsChanged extends Error {}
const cancelled = () => new DOMException('浙学自动学习已取消。', 'AbortError');

/** The isolated-world controller operates native DOM only; it never calls a completion API. */
export function createZjoocStudyController({ document: doc, isEnabled, getPlaybackRate = () => 'highest', getStartMode = () => 'first-unfinished', runtime, timing, reload = () => doc.defaultView!.location.reload() }: ZjoocStudyDependencies): ZjoocStudyController {
  const win = doc.defaultView!;
  const times: Timing = { poll: 100, settle: 300, load: 15000, confirmation: 30000, refreshDelay: 1500, retry: 1000, maxRetry: 10000, ...timing };
  const listeners = new Set<(state: ZjoocStudyState) => void>();
  let state: ZjoocStudyState = { phase: 'disabled', running: false, message: '浙学自动学习已关闭。', projectTitle: '', chapterTitle: '', resourceTitle: '', completed: 0, pendingConfirmation: [], skipped: [], availablePlaybackRates: [] };
  let session: ZjoocStudySession | undefined;
  let worker: Worker | undefined;
  let disposed = false;
  let hidden = false;
  let loadingSession = '';
  let sessionRevision = 0;
  let finishedCourse = '';
  let ownClick = false;
  let writes = Promise.resolve();
  let evaluationQueued = false;
  let pendingResume = false;
  let reloadStarted = false;
  let manualChange: { courseKey: string; paused: boolean; abort: AbortController } | undefined;
  const mediaOwners = new WeakMap<HTMLVideoElement, Worker>();
  const confirmed = new Set<string>();
  const pendingLabels = new Map<string, string>();

  function getState(): ZjoocStudyState { return { ...state, skipped: [...state.skipped], pendingConfirmation: [...state.pendingConfirmation], availablePlaybackRates: [...state.availablePlaybackRates] }; }
  function emit(update: Partial<ZjoocStudyState>): void {
    if (disposed) return;
    state = { ...state, ...update };
    for (const listener of listeners) listener(getState());
  }
  function persist(): Promise<void> {
    if (!session) return Promise.resolve();
    const copy = { ...session, ...(session.start ? { start: { ...session.start } } : {}), ...(session.cursor ? { cursor: { ...session.cursor } } : {}), ...(session.processed ? { processed: session.processed.map(item => ({ ...item })) } : {}) };
    writes = writes.catch(() => undefined).then(() => runtime.writeSession(copy));
    return writes;
  }
  function cancelWorker(): void {
    const previous = worker;
    if (previous?.preparingResource && session?.courseKey === previous.courseKey) {
      session.processed = session.processed?.filter(item => item.resourceId !== previous.preparingResource);
      previous.preparingResource = undefined;
      void persist().catch(() => undefined);
    }
    if (previous?.refreshingResource && !reloadStarted && session?.courseKey === previous.courseKey) {
      const entry = processed(previous.refreshingResource);
      if (entry?.refreshed) { entry.refreshed = false; void persist().catch(() => undefined); }
    }
    worker = undefined;
    previous?.abort.abort();
    if (previous?.media && !previous.media.paused) previous.media.pause();
  }
  function pause(message: string): void {
    cancelWorker();
    const route = readZjoocRoute(doc.location.href);
    emit({ phase: 'paused', running: false, message });
    if (route) void changeManualState(route.courseKey, true, false, message);
  }
  function cancelManualChange(): void {
    if (!manualChange) return;
    manualChange.abort.abort();
    manualChange = undefined;
    ++sessionRevision;
    pendingResume = false;
    loadingSession = '';
  }
  async function changeManualState(courseKey: string, paused: boolean, recheck = false, message = '', fromCurrent = false): Promise<void> {
    cancelManualChange();
    const current = { courseKey, paused, abort: new AbortController() };
    const revision = ++sessionRevision;
    manualChange = current;
    pendingResume = true;
    loadingSession = '';
    const valid = () => !disposed && !current.abort.signal.aborted && revision === sessionRevision
      && readZjoocRoute(doc.location.href)?.courseKey === courseKey && (paused || isEnabled());
    const requestedResource = readZjoocRoute(doc.location.href)?.chapterId;
    let initialized = false;
    let needsCurrentStart = false;
    let attempts = 0;
    try {
      while (valid()) {
        try {
          if (!initialized) {
            // Ordinary resume preserves the ledger and range even if the preferred mode changed.
            const saved = session?.courseKey === courseKey ? session : await runtime.readSession(courseKey);
            if (!valid()) return;
            if (session?.courseKey !== courseKey) { confirmed.clear(); pendingLabels.clear(); }
            session = saved?.courseKey === courseKey
              ? { ...saved, paused, start: saved.start ? { ...saved.start } : undefined,
                cursor: saved.cursor ? { ...saved.cursor } : undefined, processed: saved.processed?.map(item => ({ ...item })) }
              : { courseKey, paused };
            needsCurrentStart = !paused && (fromCurrent || ((recheck || (!session.cursor && !session.start)) && getStartMode() === 'current-forward'));
            if (needsCurrentStart) {
              confirmed.clear(); pendingLabels.clear();
              session.start = undefined; session.cursor = undefined; session.processed = [];
              emit({ skipped: [] });
            } else if (recheck) { session.start = undefined; session.cursor = { chapterIndex: 0 }; }
            initialized = true;
          }
          if (!session || !valid()) return;
          if (needsCurrentStart) {
            while (valid()) {
              if (readZjoocRoute(doc.location.href)?.chapterId !== requestedResource) break;
              const position = readCurrentStartPosition(doc);
              if (position) {
                await delay(times.settle, current.abort.signal);
                if (!valid()) return;
                if (JSON.stringify(position) === JSON.stringify(readCurrentStartPosition(doc))) {
                  session.start = position;
                  session.cursor = { chapterIndex: position.chapterIndex, resourceId: position.resourceId };
                  break;
                }
              }
              emit({ phase: 'waiting', running: true, message: '正在等待当前章节和内容加载，确认本次学习起点…' });
              await delay(times.poll, current.abort.signal);
            }
            if (!valid()) return;
            if (!session.start || readZjoocRoute(doc.location.href)?.chapterId !== requestedResource) {
              session.paused = true;
              emit({ phase: 'paused', running: false, message: '定位起点时页面已切换，已暂停。请在目标内容点击“从当前内容开始”。' });
            }
          }
          refreshProgress();
          await persist();
          if (needsCurrentStart && valid() && !session.paused && readZjoocRoute(doc.location.href)?.chapterId !== requestedResource) {
            session.paused = true;
            emit({ phase: 'paused', running: false, message: '保存起点时页面已切换，已暂停。请在目标内容点击“从当前内容开始”。' });
            await persist();
          }
          return;
        } catch {
          if (!valid()) return;
          emit({ phase: paused ? 'paused' : 'waiting', running: !paused,
            message: paused ? `${message} 暂停状态正在重新保存…` : '运行状态暂时无法读取或保存，正在自动重连…' });
          await delay(Math.min(times.retry * 2 ** Math.min(attempts++, 5), times.maxRetry), current.abort.signal);
        }
      }
    } catch {
      // A later stop, disable, navigation or dispose cancels the pending state change.
    } finally {
      if (revision === sessionRevision) { manualChange = undefined; pendingResume = false; queueEvaluate(); }
    }
  }
  function assertCurrent(current: Worker, checkSelection = true): void {
    const route = readZjoocRoute(doc.location.href);
    if (disposed || hidden || worker !== current || current.abort.signal.aborted || !isEnabled() || route?.courseKey !== current.courseKey) throw cancelled();
    if (checkSelection && !current.transitioning) {
      const chapter = readZjoocChapters(doc).find(item => item.active);
      const active = readZjoocResources(doc).find(item => item.active);
      if (route.chapterId !== current.chapterId || (chapter && chapter.key !== current.chapterKey)
        || (current.resourceId && active && active.id !== current.resourceId)) throw new ManualNavigation('检测到手动切换章节或内容，已暂停。点击继续将接着上次进度学习。');
    }
  }
  function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(cancelled()); return; }
      const abort = () => { win.clearTimeout(timer); reject(cancelled()); };
      const timer = win.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function waitFor<T>(current: Worker, read: () => T | undefined, timeout: number, message: string, settle = false): Promise<T> {
    const deadline = Date.now() + timeout;
    const identity = () => `${readZjoocRoute(doc.location.href)?.chapterId}:${readZjoocResources(doc).map(item => `${item.id}:${item.active}:${item.completed}`).join(',')}`;
    while (Date.now() < deadline) {
      assertCurrent(current);
      const result = read();
      if (result !== undefined && !isZjoocLoading(doc)) {
        if (!settle) return result;
        const key = identity();
        // Yield a full quiet interval: time spent inspecting a large DOM is not a settled page.
        await delay(times.settle, current.abort.signal);
        assertCurrent(current);
        const next = read();
        if (next !== undefined && !isZjoocLoading(doc) && key === identity()) return next;
      }
      await delay(times.poll, current.abort.signal);
    }
    throw new Attention(message);
  }
  function click(element: HTMLElement): void {
    ownClick = true;
    try { element.click(); } finally { ownClick = false; }
  }

  function refreshProgress(): void {
    emit({ completed: confirmed.size, pendingConfirmation: (session?.processed ?? []).filter(item => item.chapterIndex >= (session?.start?.chapterIndex ?? 0) && !confirmed.has(item.resourceId)).map(item => pendingLabels.get(item.resourceId)
      ?? `第 ${item.chapterIndex + 1} 小节 · ${item.kind === 'video' ? '视频已播放结束' : '课件已提交'}，待平台确认`) });
  }
  function syncVisibleConfirmations(): void {
    if (!session || session.courseKey !== readZjoocRoute(doc.location.href)?.courseKey || worker?.transitioning || isZjoocLoading(doc)) return;
    const allResources = readZjoocResources(doc);
    if (allResources.find(item => item.active)?.id !== readZjoocRoute(doc.location.href)?.chapterId) return;
    const chapters = readZjoocChapters(doc);
    const chapterIndex = chapters.findIndex(item => item.active);
    const start = session.start;
    if (start && (chapters[start.chapterIndex]?.key !== start.chapterKey || chapterIndex < start.chapterIndex)) return;
    const floor = start && chapterIndex === start.chapterIndex ? allResources.findIndex(item => item.id === start.resourceId) : 0;
    if (floor < 0) return;
    const resources = allResources.slice(floor);
    const excluded = new Set(allResources.slice(0, floor).map(item => item.id));
    const completed = new Set(resources.filter(item => item.completed).map(item => item.id));
    const newlyConfirmed = [...completed].some(id => !confirmed.has(id));
    const noLongerConfirmed = resources.some(item => !item.completed && confirmed.has(item.id));
    const pending = session.processed ?? [];
    const remaining = pending.filter(item => item.chapterIndex >= (start?.chapterIndex ?? 0) && !excluded.has(item.resourceId)
      && (item.kind === 'video' || !completed.has(item.resourceId)
        || (item.kind === 'courseware' && (!item.refreshed || worker?.refreshingResource === item.resourceId))));
    if (!newlyConfirmed && !noLongerConfirmed && remaining.length === pending.length) return;
    for (const item of resources) if (!item.completed) confirmed.delete(item.id);
    for (const id of completed) confirmed.add(id);
    session.processed = remaining;
    refreshProgress();
    if (remaining.length !== pending.length) void persist().catch(() => undefined);
  }
  function processed(id: string): ZjoocStudyProcessed | undefined { return session?.processed?.find(item => item.resourceId === id); }
  async function recordProcessed(current: Worker, resource: ZjoocResource, outcome: ZjoocStudyProcessed['outcome']): Promise<void> {
    assertCurrent(current);
    if (!session || resource.kind === 'unsupported') throw cancelled();
    pendingLabels.set(resource.id, `${state.chapterTitle} · ${resource.title}`);
    if (!processed(resource.id)) (session.processed ??= []).push({ resourceId: resource.id, chapterIndex: current.chapterIndex, kind: resource.kind, outcome });
    refreshProgress();
    await persist();
    assertCurrent(current);
  }
  async function recordConfirmed(id: string): Promise<void> {
    confirmed.add(id);
    if (session?.processed) session.processed = session.processed.filter(item => item.resourceId !== id || item.kind === 'video');
    refreshProgress();
    await persist();
  }
  async function retry<T>(current: Worker, action: () => Promise<T>, message: string): Promise<T> {
    let attempts = 0;
    while (true) {
      assertCurrent(current);
      try {
        const result = await action();
        assertCurrent(current);
        return result;
      }
      catch (error) {
        assertCurrent(current);
        if (error instanceof ManualNavigation || error instanceof ContentsChanged) throw error;
        const detail = error instanceof Attention ? error.message : message;
        if (attempts >= 3) {
          pause(`${detail || message} 连续重试仍未恢复，已暂停。请检查原网页后继续。`);
          throw cancelled();
        }
        emit({ phase: 'waiting', running: true, message: `${detail || message} 正在等待并重试（${attempts + 1}/3）…` });
        await delay(Math.min(times.retry * 2 ** Math.min(attempts++, 5), times.maxRetry), current.abort.signal);
      }
    }
  }

  async function selectChapter(current: Worker, key: string): Promise<void> {
    assertCurrent(current);
    const chapter = readZjoocChapters(doc).find(item => item.key === key);
    if (!chapter) throw new Attention('正在等待课程目录更新。');
    emit({ phase: 'waiting', projectTitle: chapter.projectTitle, chapterTitle: chapter.title, resourceTitle: '', playbackRate: undefined, message: '正在检查章节内容…' });
    const originalIds = readZjoocResources(doc).map(item => item.id).join(',');
    const originalRoute = readZjoocRoute(doc.location.href)!.chapterId;
    const needsNavigation = !chapter.active;
    current.transitioning = true;
    current.resourceId = undefined;
    if (needsNavigation) click(chapter.element);
    await waitFor(current, () => {
      const selected = readZjoocChapters(doc).find(item => item.key === key && item.active);
      const route = readZjoocRoute(doc.location.href);
      const resources = readZjoocResources(doc);
      const activeResource = resources.find(item => item.active);
      if (!selected || !activeResource || route?.chapterId !== activeResource.id) return undefined;
      if (needsNavigation && (route?.chapterId === originalRoute || resources.map(item => item.id).join(',') === originalIds)) return undefined;
      return selected;
    }, times.load, '章节内容尚未加载完成。', true);
    current.chapterId = readZjoocRoute(doc.location.href)!.chapterId;
    current.chapterKey = key;
    current.transitioning = false;
  }

  async function selectResource(current: Worker, id: string): Promise<ZjoocResource> {
    assertCurrent(current);
    let resource = readZjoocResources(doc).find(item => item.id === id);
    if (!resource) throw new Attention('正在等待章节内容更新。');
    current.transitioning = true;
    emit({ phase: 'waiting', resourceTitle: resource.title, playbackRate: undefined, message: '正在加载当前内容…' });
    if (!resource.active) click(resource.element);
    resource = await waitFor(current, () => {
      const item = readZjoocResources(doc).find(value => value.id === id && value.active);
      return item && readZjoocRoute(doc.location.href)?.chapterId === item.id && resourcePane(doc, item) ? item : undefined;
    }, times.load, '当前内容尚未加载完成。', true);
    // Resource tabs may update the same detail route as chapter navigation.
    current.chapterId = readZjoocRoute(doc.location.href)!.chapterId;
    current.resourceId = resource.id;
    current.transitioning = false;
    return resource;
  }

  function currentPane(current: Worker, id: string): HTMLElement | undefined {
    assertCurrent(current);
    const resource = readZjoocResources(doc).find(item => item.id === id && item.active);
    return resource ? resourcePane(doc, resource) : undefined;
  }

  async function playVideo(current: Worker, resource: ZjoocResource): Promise<void> {
    await retry(current, async () => {
      const media = await waitFor(current, () => {
        const video = currentPane(current, resource.id)?.querySelector<HTMLVideoElement>('video');
        return video && isVisible(video) ? video : undefined;
      }, times.load, '正在等待视频播放器加载。');
      current.media = media;
      mediaOwners.set(media, current);
      const assertMedia = () => {
        const pane = currentPane(current, resource.id);
        if (!media.isConnected || pane?.querySelector('video') !== media) throw new Attention('正在等待新的播放器就绪。');
        return pane;
      };
      assertMedia();
      media.muted = true;
      if (media.error) {
        current.recovery ??= { media, position: media.currentTime };
        if (current.recovery.media !== media) current.recovery = { media, position: media.currentTime };
        media.load();
        await waitFor(current, () => {
          assertMedia();
          return media.readyState >= 1 && !media.error ? true : undefined;
        }, times.load, '视频加载暂时失败。');
      }
      if (current.recovery?.media === media && media.readyState >= 1 && !media.error) {
        const position = current.recovery.position;
        if (Number.isFinite(position) && position > 0) media.currentTime = position;
        current.recovery = undefined;
      }
      let failed = false;
      const onError = () => { failed = true; };
      media.addEventListener('error', onError);
      try {
        if (!media.ended && media.paused) {
          emit({ phase: 'waiting', running: true, playbackRate: undefined, message: media.readyState < media.HAVE_FUTURE_DATA
            ? '视频正在加载，等待就绪后开始播放。' : '视频已加载，正在等待开始播放。' });
          let settled = false;
          let rejected: unknown;
          const playing = media.play();
          void playing.then(() => {
            settled = true;
            if ((worker !== current || current.abort.signal.aborted || current.media !== media || !media.isConnected)
              && mediaOwners.get(media) === current) media.pause();
          }, error => { rejected = error; settled = true; });
          await waitFor(current, () => {
            assertMedia();
            if (failed || media.error) throw new Attention('视频加载遇到临时错误。');
            return settled ? true : undefined;
          }, times.load, '正在等待视频加载并开始播放。');
          if (rejected) {
            const name = rejected && typeof rejected === 'object' && 'name' in rejected ? rejected.name : '';
            throw new Attention(name === 'NotAllowedError' ? '浏览器暂时阻止自动播放，可手动播放一次，工具箱会自动续接。' : '视频暂时无法播放。');
          }
        }
        let nextRateAttempt = 0;
        let rateAttempts = 0;
        let desiredRate: number | undefined;
        let choice = getPlaybackRate();
        let unavailable = false;
        while (!media.ended) {
          const pane = assertMedia();
          const nextChoice = getPlaybackRate();
          if (choice !== nextChoice) { choice = nextChoice; nextRateAttempt = 0; rateAttempts = 0; desiredRate = undefined; }
          if (failed || media.error) throw new Attention('视频播放遇到临时错误。');
          if (media.paused) throw new Attention('视频暂时停止，正在恢复播放。');
          if (media.readyState < media.HAVE_FUTURE_DATA || media.seeking) {
            emit({ phase: 'waiting', running: true, playbackRate: undefined,
              message: '视频正在加载或缓冲，待播放就绪后再应用所选倍速。' });
            await waitFor(current, () => {
              assertMedia();
              if (failed || media.error) throw new Attention('视频加载遇到临时错误。');
              return media.ended || (media.readyState >= media.HAVE_FUTURE_DATA && !media.seeking) ? true : undefined;
            }, times.load, '视频仍在加载或缓冲。');
            nextRateAttempt = 0;
            rateAttempts = 0;
            continue;
          }
          // CKplayer may initialize its controls only after native playback has started.
          // A delayed or ineffective rate menu must not stop otherwise healthy playback.
          if (Date.now() >= nextRateAttempt) {
            if (desiredRate === undefined || Math.abs(media.playbackRate - desiredRate) > 0.001) showPlaybackMenu(pane);
            const rates = readPlaybackRates(pane);
            const rate = preferredPlaybackRate(choice, rates);
            desiredRate = rate?.rate;
            unavailable = rates.length > 0 && choice !== 'highest' && !rate;
            if (rate && Math.abs(media.playbackRate - rate.rate) > 0.001) click(rate.element);
            nextRateAttempt = Date.now() + Math.min(times.retry * 2 ** Math.min(rateAttempts++, 5), times.maxRetry);
          }
          const applied = desiredRate !== undefined && Math.abs(media.playbackRate - desiredRate) < 0.001;
          const message = applied ? `正在以${choice === 'highest' ? '平台最高' : '所选'} ${media.playbackRate} 倍速播放。`
            : unavailable ? `当前视频未提供所选 ${choice} 倍速，实际以 ${media.playbackRate} 倍速播放；请选择其他倍速。`
              : desiredRate === undefined ? '视频已开始播放，正在等待平台倍速菜单就绪。' : `视频已开始播放，正在应用所选 ${desiredRate} 倍速。`;
          if (state.phase !== 'running' || state.playbackRate !== media.playbackRate || state.message !== message) emit({ phase: 'running', running: true, playbackRate: media.playbackRate, message });
          await delay(times.poll, current.abort.signal);
        }
        assertMedia();
        if (failed || media.error) throw new Attention('视频播放遇到临时错误。');
      } finally { media.removeEventListener('error', onError); }
    }, '正在恢复视频播放。');
  }

  async function confirm(current: Worker, resource: ZjoocResource): Promise<boolean> {
    if (resource.kind === 'video') {
      assertCurrent(current);
      current.media = undefined;
      return Boolean(readZjoocResources(doc).find(item => item.id === resource.id)?.completed);
    }
    const check = () => {
      if (resource.kind === 'courseware' && hasCoursewareFailure(doc)) throw new Attention('平台暂未确认课件提交结果。');
      if (readZjoocResources(doc).find(item => item.id === resource.id)?.completed) return true;
      return undefined;
    };
    const attempt = async () => {
      emit({ phase: 'confirming', running: true, message: '正在等待平台确认完成…' });
      await waitFor(current, check, times.confirmation,
        '平台完成状态尚未同步。', true);
      return true;
    };
    return retry(current, attempt, '刷新后正在等待课件提交结果。');
  }

  async function refreshCourseware(current: Worker, resource: ZjoocResource): Promise<boolean> {
    const entry = processed(resource.id);
    if (entry?.kind !== 'courseware' || entry.refreshed) return false;
    current.refreshingResource = resource.id;
    let requested = false;
    try {
      emit({ phase: 'confirming', running: true, message: '课件已点击，正在等待提交后刷新检测…' });
      await delay(times.refreshDelay, current.abort.signal);
      // Give the site's click handler time to finish; never reload through a visible loading state.
      await retry(current, () => waitFor(current, () => {
        const pane = currentPane(current, resource.id);
        return pane && !coursewareSubmissionBusy(pane) && !hasCoursewareFailure(doc) ? true : undefined;
      }, times.load, '课件仍在提交，等待结束后刷新。', true), '正在等待课件提交。');
      await retry(current, async () => {
        entry.refreshed = true;
        session!.cursor = { chapterIndex: current.chapterIndex, resourceId: resource.id };
        await persist();
      }, '正在保存刷新后的检查位置。');
      assertCurrent(current);
      emit({ phase: 'confirming', running: true, message: '正在刷新页面，重新检测本节视频和课件的完成状态…' });
      assertCurrent(current);
      reloadStarted = true;
      reload();
      requested = true;
      if (worker === current) cancelWorker();
      return true;
    } finally {
      current.refreshingResource = undefined;
      if (!requested) {
        reloadStarted = false;
        // A cancelled or failed refresh must remain available when this same course resumes.
        const pending = session?.courseKey === current.courseKey ? processed(resource.id) : undefined;
        if (pending && (!worker || worker === current)) {
          pending.refreshed = false;
          await persist().catch(() => undefined);
        }
      }
    }
  }

  async function completeCourseware(current: Worker, resource: ZjoocResource): Promise<void> {
    const id = resource.id;
    await retry(current, async () => {
      if (processed(id)) return;
      let iframeFailed = false;
      const onError = (event: Event) => {
        if (worker !== current || current.abort.signal.aborted) return;
        const resource = readZjoocResources(doc).find(item => item.id === id && item.active);
        const pane = resource ? resourcePane(doc, resource) : undefined;
        if (event.target instanceof win.HTMLElement && event.target.matches('iframe,embed,object') && pane?.contains(event.target)) iframeFailed = true;
      };
      doc.addEventListener('error', onError, true);
      try {
        const button = await waitFor(current, () => {
          if (iframeFailed) throw new Attention('课件暂时加载失败。');
          if (hasCoursewareFailure(doc)) throw new Attention('平台暂未确认课件操作结果。');
          const pane = currentPane(current, id);
          if (!pane) return undefined;
          // The viewer is a cross-origin built-in PDF reader; only its mount and the platform's
          // own button state can be observed.
          if (coursewareReadiness(pane) !== 'ready') return undefined;
          return coursewareButtonSubmitted(pane) ? coursewareButton(pane) : completionButton(pane);
        }, times.load, '课件尚未渲染完成或“完成学习”按钮暂不可用。');
        assertCurrent(current);
        // A previously completed PDF may still lack the tab's completion icon.
        if (!button.disabled) {
          // Persist before clicking, so a delayed storage response cannot allow a duplicate after refresh.
          current.preparingResource = id;
          try {
            await retry(current, () => recordProcessed(current, resource, 'submitted'), '正在保存课件处理进度。');
            const pane = currentPane(current, id);
            if (!pane?.contains(button) || button.disabled) throw new Attention('课件按钮已更新，正在重新检测。');
            current.preparingResource = undefined;
            click(button);
          } finally {
            if (current.preparingResource === id) {
              current.preparingResource = undefined;
              if (session?.courseKey === current.courseKey) {
                session.processed = session.processed?.filter(item => item.resourceId !== id);
                refreshProgress();
                await persist().catch(() => undefined);
              }
            }
          }
        } else {
          // A disabled button is only evidence of an earlier attempt, not platform completion.
          await retry(current, () => recordProcessed(current, resource, 'submitted'), '正在保存课件检查位置。');
        }
      } finally { doc.removeEventListener('error', onError, true); }
    }, '正在等待课件就绪。');
  }

  async function execute(current: Worker): Promise<void> {
    while (worker === current && !current.abort.signal.aborted) try {
      await retry(current, () => waitFor(current, () => readZjoocChapters(doc).length ? true : undefined, times.load, '课程目录未加载完成。', true), '正在等待课程目录。');
      const chapters = readZjoocChapters(doc).map(item => item.key);
      const start = session?.start;
      if (start && chapters[start.chapterIndex] !== start.chapterKey) throw new ManualNavigation('本次起点所在目录已变化，已暂停。请打开目标内容并点击“从当前内容开始”。');
      const chapterFloor = start?.chapterIndex ?? 0;
      const firstChapter = Math.max(chapterFloor, Math.min(session?.cursor?.chapterIndex ?? chapterFloor, chapters.length,
        ...(session?.processed ?? []).filter(item => item.chapterIndex >= chapterFloor).map(item => item.chapterIndex)));
      for (let chapterIndex = firstChapter; chapterIndex < chapters.length; chapterIndex++) {
        current.chapterIndex = chapterIndex;
        if (start && chapterIndex === start.chapterIndex && readZjoocChapters(doc).some(item => item.active && item.key === start.chapterKey)) {
          const visible = readZjoocResources(doc);
          if (visible.length && !visible.some(item => item.id === start.resourceId)) throw new ManualNavigation('本次起点内容已变化，已暂停。请打开目标内容并点击“从当前内容开始”。');
        }
        await retry(current, () => selectChapter(current, chapters[chapterIndex]), '正在等待章节内容。');
        const ids = readZjoocResources(doc).map(item => item.id);
        const resourceFloor = start && chapterIndex === start.chapterIndex ? ids.indexOf(start.resourceId) : 0;
        if (resourceFloor < 0) throw new ManualNavigation('本次起点内容已变化，已暂停。请打开目标内容并点击“从当前内容开始”。');
        const cursorId = session?.cursor?.chapterIndex === chapterIndex ? session.cursor.resourceId : undefined;
        if (start && cursorId && !ids.includes(cursorId)) throw new ManualNavigation('上次学习位置已不在本节，已暂停。请打开目标内容并点击“从当前内容开始”。');
        const firstResource = Math.max(resourceFloor, Math.min(cursorId ? Math.max(0, ids.indexOf(cursorId)) : resourceFloor,
          ...(session?.processed ?? []).filter(item => item.chapterIndex === chapterIndex)
            .map(item => ids.indexOf(item.resourceId)).filter(index => index >= resourceFloor)));
        for (let resourceIndex = firstResource; resourceIndex < ids.length; resourceIndex++) {
          const id = ids[resourceIndex];
          assertCurrent(current);
          if (!session) throw cancelled();
          session.cursor = { chapterIndex, resourceId: id };
          await retry(current, persist, '正在保存本轮进度。');
          const resource = readZjoocResources(doc).find(item => item.id === id);
          if (!resource) throw new Attention('正在等待章节内容更新。');
          pendingLabels.set(id, `${state.chapterTitle} · ${resource.title}`);
          const manualLabel = `${state.chapterTitle} · ${resource.title}：此类型需手动完成`;
          if (resource.kind === 'courseware' && processed(id) && !processed(id)!.refreshed) {
            const selected = await retry(current, () => selectResource(current, id), '正在等待已提交的课件。');
            if (await refreshCourseware(current, selected)) return;
          } else if (resource.completed) {
            emit({ skipped: state.skipped.filter(item => item !== manualLabel) });
            await retry(current, () => recordConfirmed(id), '正在保存已确认进度。');
          } else if (resource.kind === 'unsupported') {
            if (!resource.active) click(resource.element);
            emit({ resourceTitle: resource.title, skipped: [...new Set([...state.skipped, manualLabel])] });
            pause('当前内容类型需手动完成，已暂停。手动完成后点击继续。');
            return;
          } else if (resource.kind === 'video' && processed(id)?.outcome === 'ended') {
            // This run already observed a real native ended state. A stale tab icon must not replay it.
            refreshProgress();
          } else {
            const selected = await retry(current, () => selectResource(current, id), '正在等待当前内容。');
            if (selected.completed) await retry(current, () => recordConfirmed(id), '正在保存已确认进度。');
            else {
              if (selected.kind === 'video') {
                await playVideo(current, selected);
                await retry(current, () => recordProcessed(current, selected, 'ended'), '正在保存视频播放进度。');
              } else {
                await completeCourseware(current, selected);
                if (await refreshCourseware(current, selected)) return;
              }
              if (await confirm(current, selected)) await retry(current, () => recordConfirmed(id), '正在保存已确认进度。');
            }
          }
          assertCurrent(current);
          if (session?.courseKey !== current.courseKey) throw cancelled();
          session.cursor = resourceIndex + 1 < ids.length ? { chapterIndex, resourceId: ids[resourceIndex + 1] } : { chapterIndex };
          await retry(current, persist, '正在保存本轮进度。');
        }
        const chapterConfirmed = () => {
          const resources = readZjoocResources(doc);
          if (!resources.length) return undefined;
          const floor = start && chapterIndex === start.chapterIndex ? resources.findIndex(item => item.id === start.resourceId) : 0;
          if (floor < 0) throw new ManualNavigation('本次起点内容已变化，已暂停。请重新选择起点。');
          const scoped = resources.slice(floor);
          if (ids.slice(resourceFloor).some(id => !scoped.some(item => item.id === id))) {
            if (start) throw new ManualNavigation('本节学习范围已变化，已暂停。请重新选择起点。');
            return undefined;
          }
          if (scoped.some(item => !ids.includes(item.id) || (item.kind === 'unsupported' && !item.completed))) {
            session!.cursor = { chapterIndex };
            throw new ContentsChanged('本节内容已更新，正在重新检查。');
          }
          if (scoped.some(item => !item.completed)) return undefined;
          syncVisibleConfirmations();
          return true;
        };
        const ready = chapterConfirmed();
        emit({ phase: ready ? 'waiting' : 'confirming', running: true,
          message: ready ? '本节学习范围已确认，正在继续…' : '正在核对本节学习范围，确认完成后再进入下一节…' });
        await retry(current, () => waitFor(current, chapterConfirmed, times.confirmation,
          '本节仍有任务未获平台确认，正在继续检测。', true), '正在等待本节任务确认。');
        assertCurrent(current);
        if (session?.processed) session.processed = session.processed.filter(item => item.chapterIndex !== chapterIndex);
        session!.cursor = { chapterIndex: chapterIndex + 1 };
        await retry(current, persist, '正在保存下一节位置。');
      }
      assertCurrent(current);
      // A growing or replaced directory must be rescanned rather than misreported as complete.
      if (readZjoocChapters(doc).map(item => item.key).join('|') !== chapters.join('|')) {
        if (start) throw new ManualNavigation('课程目录发生变化，已暂停。请打开目标内容并重新选择起点。');
        if (session) session.cursor = { chapterIndex: 0 };
        throw new Attention('课程目录发生变化，正在重新检查全部章节。');
      }
      finishedCourse = current.courseKey;
      worker = undefined;
      emit({ phase: 'complete', running: false, message: completionMessage() });
      return;
    } catch (error) {
      if (worker !== current || current.abort.signal.aborted || disposed) return;
      if (!isEnabled() || !readZjoocRoute(doc.location.href)) { cancelWorker(); queueEvaluate(); return; }
      if (error instanceof ManualNavigation) { pause(error.message); return; }
      emit({ phase: 'waiting', running: true, message: '页面正在更新，将自动从本轮进度续接…' });
      try { await delay(times.retry, current.abort.signal); } catch { return; }
    }
  }

  function completionMessage(): string {
    if (session?.start) return '本次起点至课程末尾的内容已获平台确认；起点之前的内容未检查。';
    return state.pendingConfirmation.length ? '已处理至课程最后一节，仍有内容待平台确认。' : '已完成至课程最后一节。';
  }

  async function evaluate(): Promise<void> {
    if (disposed || hidden) return;
    const route = readZjoocRoute(doc.location.href);
    const activeVideo = route ? readZjoocResources(doc).find(resource => resource.active && resource.kind === 'video') : undefined;
    const videoPane = activeVideo ? resourcePane(doc, activeVideo) : undefined;
    const rates = videoPane ? readPlaybackRates(videoPane).map(item => item.rate).filter(isZjoocPlaybackRate) as number[] : [];
    if (rates.join(',') !== state.availablePlaybackRates.join(',')) emit({ availablePlaybackRates: rates });
    if (!activeVideo && state.playbackRate !== undefined) emit({ playbackRate: undefined });
    if (manualChange && (manualChange.courseKey !== route?.courseKey || (!manualChange.paused && !isEnabled()))) cancelManualChange();
    if (!route) { cancelWorker(); emit({ phase: 'unsupported', running: false, message: '请先在“我的课程”点击“进入学习”，再启用自动学习。' }); return; }
    if (!isEnabled()) { cancelWorker(); emit({ phase: 'disabled', running: false, message: '浙学自动学习已关闭。' }); return; }
    if (reloadStarted) return;
    if (pendingResume) return;
    syncVisibleConfirmations();
    if (worker) {
      if (worker.courseKey !== route.courseKey) cancelWorker();
      else { try { assertCurrent(worker); } catch (error) { if (error instanceof ManualNavigation) pause(error.message); else cancelWorker(); } return; }
    }
    if (session?.courseKey !== route.courseKey) {
      if (loadingSession === route.courseKey) return;
      const revision = ++sessionRevision;
      loadingSession = route.courseKey;
      emit({ phase: 'waiting', running: false, message: '正在读取本课程的运行状态…', completed: 0, pendingConfirmation: [], skipped: [], projectTitle: '', chapterTitle: '', resourceTitle: '', playbackRate: undefined });
      try {
        const saved = await runtime.readSession(route.courseKey);
        if (disposed || revision !== sessionRevision || readZjoocRoute(doc.location.href)?.courseKey !== route.courseKey) return;
        confirmed.clear(); pendingLabels.clear();
        session = saved?.courseKey === route.courseKey ? { ...saved,
          start: saved.start ? { ...saved.start } : undefined,
          cursor: saved.cursor ? { ...saved.cursor } : undefined,
          processed: saved.processed?.map(item => ({ ...item })) }
          : { courseKey: route.courseKey, paused: false };
        refreshProgress();
      } catch {
        if (disposed || revision !== sessionRevision) return;
        emit({ phase: 'waiting', running: false, message: '暂时无法读取运行状态，正在自动重连…' });
        return;
      } finally { if (revision === sessionRevision) loadingSession = ''; }
      if (!isEnabled() || hidden) { queueEvaluate(); return; }
    }
    if (session?.paused) { if (state.phase !== 'paused') emit({ phase: 'paused', running: false, message: '当前课程已暂停，点击继续将接着上次进度学习。' }); return; }
    if (!session?.cursor && !session?.start && getStartMode() === 'current-forward') {
      void changeManualState(route.courseKey, false, false, '', true);
      return;
    }
    if (finishedCourse === route.courseKey) {
      if (state.phase !== 'complete') emit({ phase: 'complete', running: false, message: completionMessage() });
      return;
    }
    const active = readZjoocChapters(doc).find(item => item.active);
    worker = { abort: new AbortController(), courseKey: route.courseKey, chapterId: route.chapterId, chapterKey: active?.key ?? '', transitioning: true, chapterIndex: session?.cursor?.chapterIndex ?? 0 };
    emit({ phase: 'waiting', running: true, message: session?.cursor ? '正在从本轮进度续接…' : '正在寻找首个未完成内容…' });
    void execute(worker);
  }
  function queueEvaluate(): void {
    if (evaluationQueued || disposed) return;
    evaluationQueued = true;
    win.queueMicrotask(() => { evaluationQueued = false; void evaluate(); });
  }
  function onNavigation(event: Event): void {
    if (ownClick || (!worker && (!manualChange || manualChange.paused))) return;
    const element = event.target instanceof win.Element ? event.target : undefined;
    if (element?.closest('#pane-Chapter .el-menu-item, [role="tab"][id^="tab-"]')) pause('已手动切换章节或内容。点击继续将接着上次进度学习。');
  }
  const observer = new win.MutationObserver(records => {
    // Ignore isolated UI changes in shadow roots; page route/loading/selection changes are relevant.
    if (records.length) queueEvaluate();
  });
  // Content scripts can start before documentElement exists.
  observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'hidden', 'style'] });
  const monitor = win.setInterval(queueEvaluate, 250);
  const onHide = () => { hidden = true; cancelWorker(); };
  const onShow = () => { hidden = false; queueEvaluate(); };
  doc.addEventListener('click', onNavigation, true);
  win.addEventListener('popstate', queueEvaluate);
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  queueEvaluate();

  return {
    getState,
    subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); },
    start(recheck = false) {
      const route = readZjoocRoute(doc.location.href);
      if (!route || !isEnabled() || disposed) { queueEvaluate(); return; }
      if (worker && !worker.abort.signal.aborted) return;
      finishedCourse = '';
      emit({ phase: 'waiting', running: true, message: '正在读取本轮进度并继续…' });
      void changeManualState(route.courseKey, false, recheck);
    },
    startFromCurrent() {
      const route = readZjoocRoute(doc.location.href);
      if (!route || !isEnabled() || disposed || reloadStarted) { queueEvaluate(); return; }
      cancelWorker();
      finishedCourse = '';
      emit({ phase: 'waiting', running: true, message: '正在将当前内容设为本次学习起点…' });
      void changeManualState(route.courseKey, false, false, '', true);
    },
    stop() { if (!disposed) pause('已暂停，点击继续将接着上次进度学习。'); },
    settingsChanged: queueEvaluate,
    dispose() {
      disposed = true; cancelManualChange(); ++sessionRevision; cancelWorker(); observer.disconnect(); win.clearInterval(monitor);
      doc.removeEventListener('click', onNavigation, true); win.removeEventListener('popstate', queueEvaluate);
      win.removeEventListener('pagehide', onHide); win.removeEventListener('pageshow', onShow); listeners.clear();
    },
  };
}
