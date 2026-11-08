import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createZjoocStudyController } from '../src/features/zjooc-study/controller';
import { createZjoocStudyView } from '../src/features/zjooc-study/ui';
import { preferredPlaybackRate, type ZjoocPlaybackRate } from '../src/features/zjooc-study/playback-rate';
import { defaultSettings, normalizeSettings, type Settings } from '../src/features/toolbox-settings/types';
import type { ZjoocStudySession, ZjoocStudyState } from '../src/features/zjooc-study/types';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for study state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Constructed course DOM: native media is simulated, while the production controller and selectors run.
function courseFixture(initial: ZjoocPlaybackRate = 'highest', secondRates = [4, 2, 1]) {
  const courseKey = 'c'.repeat(32);
  const ids = ['a'.repeat(32), 'b'.repeat(32)];
  const base = `https://www.zjooc.cn/ucenter/student/course/study/${courseKey}/plan/detail/`;
  const dom = new JSDOM(`<header class="el-header"><ul><li>项目1</li><li>1.1 基础</li></ul></header>
    <div id="pane-Chapter"><div class="el-submenu"><div class="el-submenu__title">项目1</div><li class="el-menu-item is-active">1.1 基础</li></div></div>
    <div class="el-tabs">${ids.map((id, index) => `<div role="tab" id="tab-${id}" aria-controls="pane-${id}" aria-selected="${index === 0}"><i class="icon-shipin"></i><span class="label">视频${index + 1}</span></div>
      <section role="tabpanel" id="pane-${id}" ${index ? 'style="display:none"' : ''}><video></video><div class="playbackratep-fixture" style="display:none">${(index ? secondRates : [4, 2, 1]).map(rate => `<p>${rate === 1 ? '正常' : `${rate}倍速`}</p>`).join('')}</div></section>`).join('')}</div>`, { url: base + ids[0] });
  const doc = dom.window.document;
  const media = [...doc.querySelectorAll('video')].map(video => {
    const value = { paused: true, ended: false, plays: 0, clicks: [] as number[] };
    Object.defineProperties(video, {
      paused: { get: () => value.paused }, ended: { get: () => value.ended }, readyState: { get: () => 4 },
      playbackRate: { value: 1, writable: true },
      play: { value: async () => { value.plays++; value.paused = false; } },
      pause: { value: () => { value.paused = true; } },
    });
    for (const entry of video.parentElement!.querySelectorAll('p')) entry.addEventListener('click', () => {
      const rate = entry.textContent === '正常' ? 1 : Number.parseFloat(entry.textContent!);
      value.clicks.push(rate); video.playbackRate = rate;
    });
    return { video, value };
  });
  for (const [index, id] of ids.entries()) doc.getElementById(`tab-${id}`)!.addEventListener('click', () => {
    for (const other of ids) {
      doc.getElementById(`tab-${other}`)!.setAttribute('aria-selected', String(other === id));
      doc.getElementById(`pane-${other}`)!.style.display = other === id ? 'block' : 'none';
    }
    dom.window.history.replaceState({}, '', base + ids[index]);
  });
  let choice = initial;
  let stored: ZjoocStudySession | undefined;
  const controller = createZjoocStudyController({ document: doc, isEnabled: () => true, getPlaybackRate: () => choice,
    timing: { poll: 5, settle: 2, load: 500, confirmation: 300, retry: 5, maxRetry: 10 },
    runtime: { readSession: async () => stored, writeSession: async value => { stored = structuredClone(value); } },
  });
  return { dom, doc, ids, controller, media,
    choose(value: ZjoocPlaybackRate) { choice = value; controller.settingsChanged(); },
    finishFirst() { doc.querySelector(`#tab-${ids[0]} i`)!.classList.add('complete'); media[0].value.ended = true; },
    close() { controller.dispose(); dom.window.close(); },
  };
}

test('legacy settings keep highest speed and normalize invalid stored rate values', () => {
  assert.equal(normalizeSettings({ version: 1, enabled: false }).zjoocPlaybackRate, 'highest');
  assert.equal(normalizeSettings({ version: 1, zjoocPlaybackRate: 2 }).zjoocPlaybackRate, 2);
  for (const invalid of [0, -2, Infinity, '2', NaN, 100]) assert.equal(normalizeSettings({ version: 1, zjoocPlaybackRate: invalid }).zjoocPlaybackRate, 'highest');
  assert.equal(preferredPlaybackRate(2, [{ rate: 4 }, { rate: 1 }]), undefined);
});

test('a missing player stops after bounded recovery and does not claim platform completion', async () => {
  const fixture = courseFixture();
  fixture.doc.querySelectorAll('video').forEach(node => node.remove());
  try {
    await until(() => fixture.controller.getState().phase === 'paused');
    assert.match(fixture.controller.getState().message, /连续重试.*已暂停/);
    assert.equal(fixture.controller.getState().running, false);
    assert.equal(fixture.controller.getState().completed, 0);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(fixture.controller.getState().phase, 'paused');
  } finally { fixture.close(); }
});

test('changing the target speed updates the running video through its own menu', async () => {
  const fixture = courseFixture();
  try {
    await until(() => fixture.media[0].video.playbackRate === 4);
    fixture.choose(2);
    await until(() => fixture.media[0].video.playbackRate === 2);
    assert.deepEqual(fixture.media[0].value.clicks, [4, 2]);
    assert.equal(fixture.media[0].value.plays, 1);
    assert.match(fixture.controller.getState().message, /所选 2/);
  } finally { fixture.close(); }
});

test('a selected rate is applied to the next video instead of reverting to highest', async () => {
  const fixture = courseFixture(2);
  try {
    await until(() => fixture.media[0].video.playbackRate === 2);
    fixture.finishFirst();
    await until(() => fixture.media[1].video.playbackRate === 2);
    assert.deepEqual(fixture.media[1].value.clicks, [2]);
    assert.equal(fixture.controller.getState().resourceTitle, '视频2');
  } finally { fixture.close(); }
});

test('changing a paused task speed does not resume playback; continue applies it', async () => {
  const fixture = courseFixture();
  try {
    await until(() => fixture.media[0].video.playbackRate === 4);
    fixture.controller.stop();
    fixture.choose(2);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(fixture.controller.getState().phase, 'paused');
    assert.equal(fixture.media[0].value.paused, true);
    assert.deepEqual(fixture.media[0].value.clicks, [4]);
    fixture.controller.start();
    await until(() => fixture.media[0].video.playbackRate === 2);
  } finally { fixture.close(); }
});

test('a later video with different rate choices keeps native playback and explains the unavailable target', async () => {
  const fixture = courseFixture(2, [4, 1]);
  try {
    await until(() => fixture.media[0].video.playbackRate === 2);
    fixture.finishFirst();
    await until(() => /未提供所选 2/.test(fixture.controller.getState().message));
    assert.equal(fixture.media[1].value.paused, false);
    assert.equal(fixture.media[1].video.playbackRate, 1);
    assert.deepEqual(fixture.media[1].value.clicks, []);
    fixture.choose('highest');
    await until(() => fixture.media[1].video.playbackRate === 4);
  } finally { fixture.close(); }
});

test('rate UI saves a paused selection without starting work and restores the previous selection after a failed save', async () => {
  const dom = new JSDOM('<body></body>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousAbort = Object.getOwnPropertyDescriptor(globalThis, 'AbortController');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: dom.window.AbortController });
  let settings = defaultSettings(); settings.features['zjooc-study'] = true;
  let starts = 0; let failSave = false;
  const state: ZjoocStudyState = { phase: 'paused', running: false, message: '已暂停', projectTitle: '', chapterTitle: '1.1 基础',
    resourceTitle: '视频1', playbackRate: 4, completed: 0, pendingConfirmation: [], skipped: [], availablePlaybackRates: [4, 2, 1] };
  const view = createZjoocStudyView({ getSettings: () => settings, saveSettings: async update => {
    if (failSave) throw new Error('Storage unavailable');
    settings = update(settings);
  }, openSettings: async () => {}, extract: async () => ({ ok: false, error: 'not used' }), getApiStatus: async () => { throw new Error('not used'); },
  zjoocStudy: { getState: () => state, subscribe(listener) { listener(state); return () => {}; }, start() { starts++; }, startFromCurrent() { starts++; }, stop() {}, settingsChanged() {}, dispose() {} } });
  dom.window.document.body.append(view.element);
  try {
    const select = view.element.querySelector<HTMLSelectElement>('#cx-zjooc-rate')!;
    assert.deepEqual([...select.options].map(option => option.value), ['highest', '4', '2', '1']);
    select.value = '2'; select.dispatchEvent(new dom.window.Event('change'));
    await until(() => !select.disabled);
    assert.equal(settings.zjoocPlaybackRate, 2);
    assert.equal(starts, 0);
    failSave = true;
    select.value = '4'; select.dispatchEvent(new dom.window.Event('change'));
    await until(() => !select.disabled);
    assert.equal(select.value, '2');
    assert.match(view.element.textContent!, /倍速保存失败/);
    assert.equal(starts, 0);
  } finally {
    view.dispose(); dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
    if (previousAbort) Object.defineProperty(globalThis, 'AbortController', previousAbort); else Reflect.deleteProperty(globalThis, 'AbortController');
  }
});

test('settings transport preserves Zjooc rate across other-platform and legacy writes', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  let stored: Settings = { ...defaultSettings(), zjoocPlaybackRate: 4, zjoocStartMode: 'current-forward' };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { id: 'rate-test', getURL: (path: string) => `chrome-extension://rate-test/${path}` },
    storage: { local: { setAccessLevel: async () => {}, get: async (key: string) => ({ [key]: stored }),
      set: async (value: Record<string, Settings>) => { stored = Object.values(value)[0]; } } },
  } });
  try {
    const { settingsRoutes, SETTINGS_WRITE } = await import('../src/features/toolbox-settings/background');
    const handle = settingsRoutes[SETTINGS_WRITE].handle;
    const sender = { id: 'rate-test', frameId: 0, tab: { id: 5 }, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' };
    await handle({ settings: { ...stored, zjoocPlaybackRate: 2, zjoocStartMode: 'first-unfinished' } }, sender);
    assert.equal(stored.zjoocPlaybackRate, 4);
    assert.equal(stored.zjoocStartMode, 'current-forward');
    await handle({ settings: { ...stored, zjoocPlaybackRate: 2 } }, { ...sender, url: 'https://www.zjooc.cn/ucenter/student/course/build/list' });
    assert.equal(stored.zjoocPlaybackRate, 2);
    const legacy: Partial<Settings> = { ...stored }; delete legacy.zjoocPlaybackRate; delete legacy.zjoocStartMode;
    await handle({ settings: legacy }, sender);
    assert.equal(stored.zjoocPlaybackRate, 2);
    assert.equal(stored.zjoocStartMode, 'current-forward');
    await assert.rejects(handle({ settings: { ...stored, zjoocPlaybackRate: 100 } }, sender), /无效/);
    await assert.rejects(handle({ settings: { ...stored, zjoocStartMode: 'here' } }, sender), /无效/);
    await handle({ settings: { ...stored, zjoocStartMode: 'first-unfinished' } }, { ...sender, url: 'https://www.zjooc.cn/ucenter/student/course/build/list' });
    assert.equal(stored.zjoocStartMode, 'first-unfinished');
  } finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); }
});
