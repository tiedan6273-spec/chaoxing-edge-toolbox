import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createZjoocStudyController } from '../src/features/zjooc-study/controller';
import { createZjoocStudyView } from '../src/features/zjooc-study/ui';
import { normalizeZjoocStartMode, readCurrentStartPosition, type ZjoocStartMode } from '../src/features/zjooc-study/start-position';
import { defaultSettings, normalizeSettings } from '../src/features/toolbox-settings/types';
import type { ZjoocStudyController, ZjoocStudySession, ZjoocStudyState } from '../src/features/zjooc-study/types';

const courseKey = 'c'.repeat(32);
const ids = ['1', '2', '3', '4', '5', '6'].map(value => value.repeat(32));
const chapters = [[ids[0], ids[1]], [ids[2], ids[3], ids[4]], [ids[5]]];
const base = `https://www.zjooc.cn/ucenter/student/course/study/${courseKey}/plan/detail/`;
const anchor = { chapterIndex: 1, chapterKey: '1:项目1:第2节', resourceId: ids[3] };

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for current-forward behavior');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function deferred() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

/** Constructed native player/courseware DOM; no real course or platform completion API is used. */
function courseFixture(options: {
  mode?: ZjoocStartMode; saved?: ZjoocStudySession; courseware?: boolean;
  readGate?: Promise<void>; writeGate?: Promise<void>;
} = {}) {
  const dom = new JSDOM(`<header class="el-header"><ul><li>项目1</li><li>第2节</li></ul></header>
    <div id="pane-Chapter"><div class="el-submenu"><div class="el-submenu__title">项目1</div>${chapters.map((_, index) => `<li class="el-menu-item">第${index + 1}节</li>`).join('')}</div></div><main class="el-tabs"></main>`, { url: base + ids[3] });
  const doc = dom.window.document;
  const completed = new Set<string>();
  const plays: string[] = []; const clicks: string[] = []; const visits: number[] = [];
  const media = new Map<string, { video: HTMLVideoElement; ended: boolean; paused: boolean }>();
  const writes: ZjoocStudySession[] = [];
  let saved = options.saved ? structuredClone(options.saved) : undefined;
  let reloads = 0;
  let enabled = true;

  function selectResource(id: string) {
    for (const tab of doc.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const selected = tab.id === `tab-${id}`;
      tab.setAttribute('aria-selected', String(selected));
      doc.getElementById(tab.getAttribute('aria-controls')!)!.style.display = selected ? '' : 'none';
    }
    dom.window.history.replaceState({}, '', base + id);
  }
  function go(chapterIndex: number, resourceIndex = 0) {
    for (const [index, chapter] of [...doc.querySelectorAll('.el-menu-item')].entries()) chapter.classList.toggle('is-active', index === chapterIndex);
    doc.querySelector('header li:last-child')!.textContent = `第${chapterIndex + 1}节`;
    doc.querySelector('main')!.innerHTML = chapters[chapterIndex].map(id => {
      const courseware = options.courseware && id === ids[3];
      // The earlier task in the start section is deliberately unsupported and incomplete.
      const icon = id === ids[2] ? 'icon-discussion' : courseware ? 'icon-iconset0387' : 'icon-shipin';
      return `<div role="tab" id="tab-${id}" aria-controls="pane-${id}" aria-selected="false"><i class="${icon} ${completed.has(id) ? 'complete' : ''}"></i><span class="label">内容${ids.indexOf(id) + 1}</span></div><section role="tabpanel" id="pane-${id}" style="display:none">${courseware ? '<embed type="application/pdf"><button>完成学习</button>' : '<video></video><div class="playbackratep-fixture"><p>正常</p></div>'}</section>`;
    }).join('');
    for (const id of chapters[chapterIndex]) {
      const tab = doc.getElementById(`tab-${id}`)!;
      tab.addEventListener('click', () => { clicks.push(id); selectResource(id); });
      const video = doc.querySelector<HTMLVideoElement>(`#pane-${id} video`);
      if (video) {
        const item = { video, ended: false, paused: true }; media.set(id, item);
        Object.defineProperties(video, {
          paused: { get: () => item.paused }, ended: { get: () => item.ended }, readyState: { get: () => 4 },
          play: { value: async () => { item.paused = false; plays.push(id); } },
          pause: { value: () => { item.paused = true; } },
        });
      }
      const button = doc.querySelector<HTMLButtonElement>(`#pane-${id} button`);
      button?.addEventListener('click', () => { clicks.push(`submit:${id}`); button.disabled = true; button.classList.add('is-disabled'); });
    }
    selectResource(chapters[chapterIndex][resourceIndex]);
  }
  for (const [index, chapter] of [...doc.querySelectorAll<HTMLElement>('.el-menu-item')].entries()) chapter.addEventListener('click', () => { visits.push(index); go(index); });
  go(1, 1);

  const create = () => createZjoocStudyController({ document: doc, isEnabled: () => enabled,
    getStartMode: () => options.mode ?? 'current-forward',
    timing: { poll: 5, settle: 2, load: 500, confirmation: 300, refreshDelay: 2, retry: 5, maxRetry: 10 },
    runtime: { readSession: async () => { await options.readGate; return saved; }, writeSession: async session => {
      writes.push(structuredClone(session)); await options.writeGate; saved = structuredClone(session);
    } }, reload: () => { reloads++; },
  });
  let controller = create();
  return { dom, doc, plays, clicks, visits, media, writes, go,
    get controller() { return controller; }, get saved() { return saved; }, get reloads() { return reloads; },
    finish(id: string) { const item = media.get(id); if (item) item.ended = true; completed.add(id); doc.querySelector(`#tab-${id} i`)?.classList.add('complete'); },
    recreate() { controller.dispose(); controller = create(); },
    disable() { enabled = false; controller.settingsChanged(); },
    close() { controller.dispose(); dom.window.close(); },
  };
}

test('current-forward starts at the selected resource, skips the prefix and advances despite earlier incomplete tasks', async () => {
  const fixture = courseFixture();
  try {
    await until(() => fixture.plays.includes(ids[3]));
    assert.deepEqual(fixture.saved?.start, anchor);
    fixture.finish(ids[3]);
    await until(() => fixture.plays.includes(ids[4]));
    fixture.finish(ids[4]);
    await until(() => fixture.plays.includes(ids[5]));
    fixture.finish(ids[5]);
    await until(() => fixture.controller.getState().phase === 'complete');
    assert.deepEqual(fixture.plays, [ids[3], ids[4], ids[5]]);
    assert.deepEqual(fixture.visits, [2]);
    assert.equal(fixture.clicks.includes(ids[2]), false);
    assert.equal(fixture.doc.querySelector(`#tab-${ids[2]} i.complete`), null);
    assert.equal(fixture.controller.getState().skipped.length, 0);
    assert.match(fixture.controller.getState().message, /起点之前的内容未检查/);
  } finally { fixture.close(); }
});

test('first-unfinished mode still scans from the beginning', async () => {
  const fixture = courseFixture({ mode: 'first-unfinished' });
  try { await until(() => fixture.plays.length > 0); assert.equal(fixture.plays[0], ids[0]); assert.equal(fixture.saved?.start, undefined); }
  finally { fixture.close(); }
});

test('explicit current start replaces an older cursor and pending ledger without revisiting them', async () => {
  const fixture = courseFixture({ saved: { courseKey, paused: true, cursor: { chapterIndex: 0, resourceId: ids[0] },
    processed: [{ chapterIndex: 0, resourceId: ids[0], kind: 'video', outcome: 'ended' }] } });
  try {
    await until(() => fixture.controller.getState().phase === 'paused');
    fixture.controller.startFromCurrent();
    await until(() => fixture.plays.includes(ids[3]));
    assert.deepEqual(fixture.saved?.start, anchor);
    assert.deepEqual(fixture.saved?.processed, []);
    assert.deepEqual(fixture.visits, []);
    assert.deepEqual(fixture.controller.getState().pendingConfirmation, []);
  } finally { fixture.close(); }
});

test('an older pending entry cannot pull a saved anchored run before its scope', async () => {
  const fixture = courseFixture({ saved: { courseKey, paused: false, start: anchor, cursor: { chapterIndex: 0, resourceId: ids[0] },
    processed: [{ chapterIndex: 0, resourceId: ids[0], kind: 'video', outcome: 'ended' }, { chapterIndex: 1, resourceId: ids[2], kind: 'video', outcome: 'ended' }] } });
  try { await until(() => fixture.plays.length > 0); assert.deepEqual(fixture.plays, [ids[3]]); assert.deepEqual(fixture.visits, []); }
  finally { fixture.close(); }
});

test('reanchoring a running task pauses the old player and starts only the newly selected content', async () => {
  const fixture = courseFixture();
  try {
    await until(() => fixture.plays.includes(ids[3]));
    const previous = fixture.media.get(ids[3])!;
    fixture.go(2); fixture.controller.startFromCurrent();
    await until(() => fixture.plays.includes(ids[5]));
    assert.equal(previous.paused, true);
    assert.deepEqual(fixture.plays, [ids[3], ids[5]]);
    assert.deepEqual(fixture.saved?.start, { chapterIndex: 2, chapterKey: '2:项目1:第3节', resourceId: ids[5] });
  } finally { fixture.close(); }
});

test('pause, a manual page change and ordinary continue preserve the saved anchor and next resource', async () => {
  const fixture = courseFixture();
  try {
    await until(() => fixture.plays.includes(ids[3])); fixture.finish(ids[3]);
    await until(() => fixture.plays.includes(ids[4]));
    fixture.controller.stop(); await until(() => fixture.saved?.paused === true);
    fixture.go(0); fixture.controller.start();
    await until(() => fixture.plays.filter(id => id === ids[4]).length === 2);
    assert.deepEqual(fixture.saved?.start, anchor);
    assert.deepEqual(fixture.plays, [ids[3], ids[4], ids[4]]);
    assert.deepEqual(fixture.visits, [1]);
  } finally { fixture.close(); }
});

test('a recreated controller resumes the exact resource in the saved scope', async () => {
  const fixture = courseFixture();
  try {
    await until(() => fixture.plays.includes(ids[3])); fixture.finish(ids[3]);
    await until(() => fixture.plays.includes(ids[4]));
    fixture.recreate();
    await until(() => fixture.plays.filter(id => id === ids[4]).length === 2);
    assert.deepEqual(fixture.saved?.start, anchor);
    assert.equal(fixture.plays.includes(ids[0]), false);
    assert.equal(fixture.plays.filter(id => id === ids[3]).length, 1);
  } finally { fixture.close(); }
});

test('courseware refresh preserves the exact anchor and does not resubmit or inspect the prefix', async () => {
  const fixture = courseFixture({ courseware: true });
  try {
    await until(() => fixture.reloads === 1);
    assert.deepEqual(fixture.saved?.start, anchor);
    assert.deepEqual(fixture.saved?.cursor, { chapterIndex: 1, resourceId: ids[3] });
    assert.equal(fixture.saved?.processed?.[0].refreshed, true);
    fixture.finish(ids[3]); fixture.recreate();
    await until(() => fixture.plays.includes(ids[4]));
    assert.deepEqual(fixture.clicks.filter(value => value.startsWith('submit:')), [`submit:${ids[3]}`]);
    assert.equal(fixture.clicks.includes(ids[2]), false);
    assert.equal(fixture.reloads, 1);
  } finally { fixture.close(); }
});

test('a loading or unselected page waits for the requested resource instead of falling back to the first chapter', async () => {
  const fixture = courseFixture();
  const mask = fixture.doc.createElement('div'); mask.className = 'el-loading-mask'; fixture.doc.body.append(mask);
  fixture.doc.getElementById(`tab-${ids[3]}`)!.setAttribute('aria-selected', 'false');
  try {
    await until(() => /确认本次学习起点/.test(fixture.controller.getState().message));
    assert.deepEqual(fixture.plays, []); assert.deepEqual(fixture.visits, []);
    mask.remove();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(fixture.plays, []);
    fixture.doc.getElementById(`tab-${ids[3]}`)!.setAttribute('aria-selected', 'true');
    await until(() => fixture.plays.includes(ids[3]));
    assert.deepEqual(fixture.saved?.start, anchor);
  } finally { fixture.close(); }
});

test('navigation while reading a start request pauses rather than acting on a different page', async () => {
  const gate = deferred();
  const fixture = courseFixture({ readGate: gate.promise });
  try {
    fixture.controller.startFromCurrent(); fixture.go(2); gate.release();
    await until(() => fixture.saved?.paused === true);
    assert.deepEqual(fixture.plays, []); assert.deepEqual(fixture.visits, []);
    assert.match(fixture.controller.getState().message, /页面已切换/);
  } finally { gate.release(); fixture.close(); }
});

test('navigation during an asynchronous start save cannot start the old range', async () => {
  const gate = deferred();
  const fixture = courseFixture({ writeGate: gate.promise });
  try {
    await until(() => fixture.writes.some(value => Boolean(value.start)));
    fixture.go(2); gate.release();
    await until(() => fixture.saved?.paused === true);
    assert.deepEqual(fixture.plays, []); assert.deepEqual(fixture.visits, []);
    assert.match(fixture.controller.getState().message, /页面已切换/);
  } finally { gate.release(); fixture.close(); }
});

test('stop or disable cancels a start that is waiting for page readiness', async () => {
  for (const action of ['stop', 'disable'] as const) {
    const fixture = courseFixture();
    const mask = fixture.doc.createElement('div'); mask.className = 'el-loading-mask'; fixture.doc.body.append(mask);
    try {
      await until(() => /确认本次学习起点/.test(fixture.controller.getState().message));
      if (action === 'stop') fixture.controller.stop(); else fixture.disable();
      mask.remove();
      await until(() => fixture.controller.getState().phase === (action === 'stop' ? 'paused' : 'disabled'));
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.deepEqual(fixture.plays, []);
    } finally { fixture.close(); }
  }
});

test('a removed resource anchor or changed chapter directory pauses instead of scanning from zero', async () => {
  for (const change of ['resource', 'directory'] as const) {
    const fixture = courseFixture({ saved: { courseKey, paused: false, start: anchor, cursor: { chapterIndex: 1, resourceId: ids[3] } } });
    if (change === 'resource') fixture.doc.getElementById(`tab-${ids[3]}`)!.remove();
    else fixture.doc.querySelectorAll('.el-menu-item')[1].textContent = '新的章节';
    try {
      await until(() => fixture.controller.getState().phase === 'paused');
      assert.deepEqual(fixture.plays, []); assert.deepEqual(fixture.visits, []);
      assert.match(fixture.controller.getState().message, /起点/);
    } finally { fixture.close(); }
  }
});

test('start mode normalizes legacy settings and rejects stale selected tabs', () => {
  assert.equal(normalizeSettings({ version: 1 }).zjoocStartMode, 'first-unfinished');
  assert.equal(normalizeZjoocStartMode('current-forward'), 'current-forward');
  assert.equal(normalizeZjoocStartMode('current'), 'first-unfinished');
  const dom = new JSDOM('<div role="tab" id="tab-11111111111111111111111111111111" aria-selected="true"></div>', { url: base + ids[3] });
  try { assert.equal(readCurrentStartPosition(dom.window.document), undefined); } finally { dom.window.close(); }
});

test('session transport retains a validated exact start and remains compatible with older sessions', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const storage: Record<string, unknown> = {};
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { id: 'start-test' }, storage: { session: {
      get: async (key: string) => ({ [key]: storage[key] }), set: async (items: Record<string, unknown>) => { Object.assign(storage, items); },
    } },
  } });
  try {
    const { zjoocStudyRoutes } = await import('../src/features/zjooc-study/background');
    const write = zjoocStudyRoutes['toolbox:zjooc-study:session:write'].handle;
    const read = zjoocStudyRoutes['toolbox:zjooc-study:session:read'].handle;
    const sender = { id: 'start-test', frameId: 0, tab: { id: 5 }, url: base + ids[3] };
    const session = { courseKey, paused: false, start: { ...anchor, privateField: 'discard' }, cursor: { chapterIndex: 1, resourceId: ids[3] } };
    await write({ session }, sender);
    const value = await read({ courseKey }, sender) as ZjoocStudySession;
    assert.deepEqual(value.start, anchor);
    assert.deepEqual(value.cursor, session.cursor);
    await assert.rejects(write({ session: { ...session, start: { ...anchor, resourceId: 'invalid' } } }, sender), /无效/);
    await assert.rejects(write({ session: { ...session, start: { ...anchor, chapterKey: '' } } }, sender), /无效/);
    await write({ session: { courseKey, paused: true, cursor: { chapterIndex: 0 } } }, sender);
    assert.equal((await read({ courseKey }, sender) as ZjoocStudySession).start, undefined);
  } finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); }
});

test('start mode UI only saves the preference; the explicit button reanchors and ordinary continue resumes', async () => {
  const dom = new JSDOM('<body></body>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousAbort = Object.getOwnPropertyDescriptor(globalThis, 'AbortController');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: dom.window.AbortController });
  let settings = defaultSettings(); settings.features['zjooc-study'] = true;
  let starts = 0; let reanchors = 0; let failSave = false;
  const state: ZjoocStudyState = { phase: 'paused', running: false, message: '已暂停', projectTitle: '', chapterTitle: '第2节', resourceTitle: '内容4', completed: 0, pendingConfirmation: [], skipped: [], availablePlaybackRates: [] };
  const controller: ZjoocStudyController = { getState: () => state, subscribe(listener) { listener(state); return () => {}; },
    start() { starts++; }, startFromCurrent() { reanchors++; }, stop() {}, settingsChanged() {}, dispose() {} };
  const view = createZjoocStudyView({ getSettings: () => settings, saveSettings: async update => { if (failSave) throw new Error('Unavailable'); settings = update(settings); },
    openSettings: async () => {}, extract: async () => ({ ok: false, error: 'not used' }), getApiStatus: async () => { throw new Error('not used'); }, zjoocStudy: controller });
  try {
    dom.window.document.body.append(view.element);
    const select = view.element.querySelector<HTMLSelectElement>('#cx-zjooc-start-mode')!;
    const current = view.element.querySelector<HTMLButtonElement>('[data-zjooc-action="current"]')!;
    assert.equal(current.hidden, true);
    select.value = 'current-forward'; select.dispatchEvent(new dom.window.Event('change'));
    await until(() => !select.disabled);
    assert.equal(settings.zjoocStartMode, 'current-forward'); assert.equal(starts, 0); assert.equal(reanchors, 0);
    current.click(); assert.equal(reanchors, 1); assert.equal(starts, 0);
    view.element.querySelector<HTMLButtonElement>('[data-zjooc-action="start"]')!.click();
    assert.equal(starts, 1); assert.equal(reanchors, 1);
    failSave = true; select.value = 'first-unfinished'; select.dispatchEvent(new dom.window.Event('change'));
    await until(() => !select.disabled);
    assert.equal(select.value, 'current-forward'); assert.match(view.element.textContent!, /起点保存失败/);
  } finally {
    view.dispose(); dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
    if (previousAbort) Object.defineProperty(globalThis, 'AbortController', previousAbort); else Reflect.deleteProperty(globalThis, 'AbortController');
  }
});
