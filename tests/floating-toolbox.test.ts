import test from 'node:test';
import assert from 'node:assert/strict';
import { describeToolboxTask } from '../src/features/floating-toolbox/task-status';
import { clampPoint, viewportArea } from '../src/features/floating-toolbox/geometry';
import { defaultUiPreferences, normalizeToolboxView, normalizeUiPreferences } from '../src/features/floating-toolbox/preferences';
import { assessmentResourceKey, createAnswerOwnership } from '../src/features/question-answer/ownership';
import type { QuestionAnswerController, QuestionAnswerState } from '../src/features/question-answer/types';
import type { ZjoocStudyController, ZjoocStudyState } from '../src/features/zjooc-study/types';

function studyFixture() {
  let state: ZjoocStudyState = { phase: 'running', running: true, message: '正在学习', projectTitle: '', chapterTitle: '', resourceTitle: '', completed: 3, pendingConfirmation: [], skipped: [], availablePlaybackRates: [] };
  let starts = 0; let stops = 0;
  const controller = { getState: () => state, start() { starts++; }, stop() { stops++; } } as unknown as ZjoocStudyController;
  return { controller, setState(value: Partial<ZjoocStudyState>) { state = { ...state, ...value }; }, calls: () => ({ starts, stops }) };
}

test('describing minimized or floating state does not start or stop a task', () => {
  const fixture = studyFixture();
  for (let index = 0; index < 4; index++) {
    const task = describeToolboxTask('zjooc-study', { zjoocStudy: fixture.controller });
    assert.equal(task.label, '学习中');
    assert.equal(task.detail, '已确认 3 项');
    assert.equal(task.action?.label, '暂停');
  }
  assert.deepEqual(fixture.calls(), { starts: 0, stops: 0 });
});

test('compact pause and continue invoke only the intended controller action', () => {
  const fixture = studyFixture();
  describeToolboxTask('zjooc-study', { zjoocStudy: fixture.controller }).action!.run();
  assert.deepEqual(fixture.calls(), { starts: 0, stops: 1 });
  fixture.setState({ phase: 'paused', running: false });
  const paused = describeToolboxTask('zjooc-study', { zjoocStudy: fixture.controller });
  assert.equal(paused.tone, 'paused');
  assert.equal(paused.action?.label, '继续');
  paused.action!.run();
  assert.deepEqual(fixture.calls(), { starts: 1, stops: 1 });
});

test('unconfirmed course items remain visible after the processing run ends', () => {
  const fixture = studyFixture();
  fixture.setState({ phase: 'complete', running: false, pendingConfirmation: ['课件一'] });
  const task = describeToolboxTask('zjooc-study', { zjoocStudy: fixture.controller });
  assert.equal(task.tone, 'attention');
  assert.equal(task.label, '待确认');
  assert.match(task.detail, /待确认 1/);
  assert.equal(task.action, undefined);
});

test('paused answers from a stale page cannot resume from the mini bar', () => {
  const state: QuestionAnswerState = { phase: 'paused', running: false, source: null, rows: [], message: '页面变化', previewStale: true };
  const controller = { getState: () => state } as unknown as QuestionAnswerController;
  const task = describeToolboxTask('zjooc-exam', { questionAnswer: controller });
  assert.equal(task.action, undefined);
  assert.equal(task.tone, 'attention');
  assert.match(task.message, /平台计时不变/);
});

test('UI preferences preserve independent hidden and minimized states', () => {
  assert.equal(defaultUiPreferences().minimized, true);
  const value = normalizeUiPreferences({ version: 2, x: 0.5, y: 0.2, minimized: true, hidden: true });
  assert.equal(value.hidden, true);
  assert.equal(value.minimized, true);
  assert.equal(normalizeToolboxView('zjooc-exam'), 'zjooc-exam');
});

test('panel remains within narrow or zoomed viewport bounds', () => {
  for (const viewport of [{ width: 320, height: 560 }, { width: 256, height: 440 }, { width: 1024, height: 768 }]) {
    const area = viewportArea(viewport);
    const size = { width: Math.min(360, area.width), height: Math.min(620, area.height) };
    const point = clampPoint({ x: 2000, y: 2000 }, size, viewport);
    assert.ok(point.x >= area.left && point.x + size.width <= area.left + area.width);
    assert.ok(point.y >= area.top && point.y + size.height <= area.top + area.height);
  }
});

test('paper ownership excludes another tab and releases only the owner', () => {
  const ownership = createAnswerOwnership<object>();
  const first = {}; const second = {}; const unrelated = {};
  ownership.claim('paper-1', first);
  ownership.claim('paper-1', first);
  assert.throws(() => ownership.claim('paper-1', second), /另一标签页/);
  ownership.release(unrelated);
  assert.throws(() => ownership.claim('paper-1', second));
  ownership.claim('paper-2', second);
  ownership.release(first);
  assert.doesNotThrow(() => ownership.claim('paper-1', second));
});

test('paper identity ignores ordinary anchors and query ordering, but retains SPA paper routes', () => {
  const base = 'https://mooc1.chaoxing.com/exam/test';
  assert.equal(assessmentResourceKey(`${base}?examId=1&courseId=2#q3`), assessmentResourceKey(`${base}?courseId=2&examId=1#q5`));
  assert.notEqual(assessmentResourceKey('https://www.zjooc.cn/#/ucenter/student/exam/1'), assessmentResourceKey('https://www.zjooc.cn/#/ucenter/student/exam/2'));
  assert.equal(assessmentResourceKey('https://example.com/exam/1'), undefined);
});
