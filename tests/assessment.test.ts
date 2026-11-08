import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { assessmentSceneFromUrl } from '../src/platform/assessment-routes';
import { pageContextFromUrl } from '../src/platform/page-context';
import { inspectQuestionPage as inspectChaoxing, readQuestionControl } from '../src/features/question-answer/adapters/chaoxing';
import { inspectZjoocQuestionPage } from '../src/features/question-answer/adapters/zjooc';
import { handleAnswerPageCommand } from '../src/features/question-answer/page';
import type { AnswerPageCommand, ApplicableAnswer } from '../src/features/question-answer/types';

// Constructed DOM fixtures, not captured real Zjooc pages. Real-page validation is separate.
const url = 'https://www.zjooc.cn/ucenter/student/course/course-1/exam/paper-1';
const question = (id = 'q1', multiple = false) => `<section class="question-item" data-question-id="${id}">
  <h3 class="question-title">${multiple ? '请选择所有偶数' : '1 + 1 等于多少？'}</h3>
  <label><input name="${id}" type="${multiple ? 'checkbox' : 'radio'}" value="a">A. 2</label>
  <label><input name="${id}" type="${multiple ? 'checkbox' : 'radio'}" value="b">B. 4</label>
</section>`;
function fixture(content = question(), address = url) {
  const dom = new JSDOM(`<main class="exam-paper"><h1 class="exam-title">示例考试</h1>${content}<button id="submit">交卷</button></main>`, { url: address });
  return { dom, win: dom.window as unknown as Window };
}
function writeCommand(win: Window, answer: ApplicableAnswer): Extract<AnswerPageCommand, { action: 'write' }> {
  const page = inspectZjoocQuestionPage(win);
  const entry = page.entries[0];
  return { action: 'write', documentKey: page.snapshot.documentKey, scopeKey: page.snapshot.scopeKey,
    key: entry.snapshot.key, fingerprint: entry.snapshot.fingerprint,
    expectedVersion: readQuestionControl(win, entry).version, answer, replace: false };
}

test('shell and Chaoxing question adapter accept the same exam prefixes', () => {
  for (const prefix of ['', 'mooc2/', 'mooc-ans/', 'mooc-ans/mooc2/']) {
    const address = `https://mooc1.chaoxing.com/${prefix}exam/test`;
    const { dom, win } = fixture('', address);
    assert.equal(assessmentSceneFromUrl(address), 'exam');
    assert.equal(pageContextFromUrl(address), 'exam');
    assert.equal(inspectChaoxing(win).snapshot.scene, 'exam');
    dom.window.close();
  }
});

test('assessment routes distinguish hosts, lists and learning pages', () => {
  assert.equal(assessmentSceneFromUrl(url), 'exam');
  assert.equal(assessmentSceneFromUrl('https://www.zjooc.cn/#/ucenter/student/exam/p1'), 'exam');
  assert.equal(assessmentSceneFromUrl('https://www.zjooc.cn/ucenter/student/homework/p1'), 'homework');
  assert.equal(assessmentSceneFromUrl('https://www.zjooc.cn/ucenter/student/course/study/c/plan/detail/d'), undefined);
  assert.equal(assessmentSceneFromUrl('https://www.zjooc.cn/ucenter/teacher/exam/p1'), undefined);
  assert.equal(assessmentSceneFromUrl('https://www.zjooc.cn.evil.example/ucenter/student/exam/p1'), undefined);
  assert.equal(assessmentSceneFromUrl('garbage'), undefined);
});

test('Zjooc reads loaded questions without claiming whole-paper completeness', () => {
  const { dom, win } = fixture();
  const page = inspectZjoocQuestionPage(win);
  assert.equal(page.snapshot.scene, 'exam');
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].snapshot.kind, 'single');
  assert.deepEqual(page.entries[0].snapshot.options.map(option => option.text), ['2', '4']);
  assert.equal(page.snapshot.allLoaded, false);
  assert.equal(page.snapshot.canSave, false);
  assert.equal(page.snapshot.canSubmit, false);
  dom.window.close();
});

test('write clicks native controls, reads back, and never clicks submit', async () => {
  const { dom, win } = fixture();
  let submitted = 0;
  win.document.getElementById('submit')!.addEventListener('click', () => submitted++);
  const result = await handleAnswerPageCommand(win, writeCommand(win, { choices: ['option-1'] }));
  assert.equal(result.ok, true);
  assert.equal(result.control?.complete, true);
  assert.equal(win.document.querySelector<HTMLInputElement>('input[value="a"]')!.checked, true);
  assert.equal(submitted, 0);
  dom.window.close();
});

test('a user edit after reading the version is preserved', async () => {
  const { dom, win } = fixture();
  const command = writeCommand(win, { choices: ['option-1'] });
  win.document.querySelector<HTMLInputElement>('input[value="b"]')!.checked = true;
  const result = await handleAnswerPageCommand(win, command);
  assert.equal(result.ok, false);
  assert.match(result.error!, /已被修改/);
  assert.equal(win.document.querySelector<HTMLInputElement>('input[value="b"]')!.checked, true);
  dom.window.close();
});

test('an existing answer needs explicit replace consent', async () => {
  const { dom, win } = fixture();
  win.document.querySelector<HTMLInputElement>('input[value="b"]')!.checked = true;
  const result = await handleAnswerPageCommand(win, writeCommand(win, { choices: ['option-1'] }));
  assert.equal(result.ok, false);
  assert.match(result.error!, /已有答案/);
  dom.window.close();
});

test('navigation invalidates an in-flight question identity', async () => {
  const { dom, win } = fixture();
  const command = writeCommand(win, { choices: ['option-1'] });
  win.history.pushState({}, '', '/ucenter/student/exam/another-paper');
  const result = await handleAnswerPageCommand(win, command);
  assert.equal(result.ok, false);
  assert.equal(win.document.querySelector<HTMLInputElement>('input[value="a"]')!.checked, false);
  dom.window.close();
});

test('replacing the paper at the same URL invalidates old results', async () => {
  const { dom, win } = fixture();
  const command = writeCommand(win, { choices: ['option-1'] });
  win.document.querySelector('.exam-paper')!.outerHTML = `<main class="exam-paper">${question()}</main>`;
  const result = await handleAnswerPageCommand(win, command);
  assert.equal(result.ok, false);
  assert.match(result.error!, /页面已变化/);
  dom.window.close();
});

test('duplicate question IDs block both ambiguous questions', () => {
  const { dom, win } = fixture(question('same') + question('same'));
  const page = inspectZjoocQuestionPage(win);
  assert.equal(page.entries.length, 2);
  assert.ok(page.entries.every(entry => !entry.snapshot.supported));
  dom.window.close();
});

test('finished exam is readable but not editable', async () => {
  const { dom, win } = fixture('<div class="exam-status">已交卷</div>' + question());
  const page = inspectZjoocQuestionPage(win);
  assert.equal(page.snapshot.complete, true);
  assert.equal(readQuestionControl(win, page.entries[0]).ready, false);
  const result = await handleAnswerPageCommand(win, writeCommand(win, { choices: ['option-1'] }));
  assert.equal(result.ok, false);
  dom.window.close();
});

test('ordinary text fields require every blank, and preserve input/change events', async () => {
  const { dom, win } = fixture('<section class="question-item" data-question-id="text"><h3 class="question-title">填写两个词</h3><input type="text"><textarea></textarea></section>');
  let changed = 0;
  win.document.querySelector('textarea')!.addEventListener('change', () => changed++);
  assert.equal(inspectZjoocQuestionPage(win).entries[0].snapshot.kind, 'completion');
  const result = await handleAnswerPageCommand(win, writeCommand(win, { texts: ['甲', '乙'] }));
  assert.equal(result.ok, true);
  assert.equal(result.control?.complete, true);
  assert.equal(changed, 1);
  dom.window.close();
});

test('pause between checkbox clicks cancels remaining mutations', async () => {
  const { dom, win } = fixture(question('multi', true));
  const operation = handleAnswerPageCommand(win, writeCommand(win, { choices: ['option-1', 'option-2'] }));
  await handleAnswerPageCommand(win, { action: 'cancel' });
  const result = await operation;
  assert.equal(result.ok, false);
  assert.equal(win.document.querySelectorAll('input:checked').length, 1);
  dom.window.close();
});

test('finish commands cannot save or submit an independent Zjooc exam', async () => {
  const { dom, win } = fixture();
  const page = inspectZjoocQuestionPage(win);
  let submitted = 0;
  win.document.getElementById('submit')!.addEventListener('click', () => submitted++);
  const result = await handleAnswerPageCommand(win, { action: 'finish', documentKey: page.snapshot.documentKey,
    scopeKey: page.snapshot.scopeKey, policy: 'submit', expected: [] });
  assert.equal(result.ok, false);
  assert.equal(submitted, 0);
  dom.window.close();
});

test('native multiple-choice and judgement controls round-trip complete answers', async () => {
  for (const [content, kind, choices] of [
    [question('multi', true), 'multiple', ['option-1', 'option-2']],
    [question('judge').replace('A. 2', 'A. 正确').replace('B. 4', 'B. 错误'), 'judgement', ['option-2']],
  ] as const) {
    const { dom, win } = fixture(content);
    assert.equal(inspectZjoocQuestionPage(win).entries[0].snapshot.kind, kind);
    const result = await handleAnswerPageCommand(win, writeCommand(win, { choices: [...choices] }));
    assert.equal(result.ok, true);
    assert.equal(result.control?.complete, true);
    assert.equal(win.document.querySelectorAll('input:checked').length, choices.length);
    dom.window.close();
  }
});

test('same-origin embedded papers inherit the exam route and invalidate on parent navigation', async () => {
  const { dom, win } = fixture('<iframe id="paper-frame"></iframe>');
  const frame = win.document.querySelector<HTMLIFrameElement>('#paper-frame')!.contentWindow!;
  frame.document.body.innerHTML = `<main class="exam-paper">${question()}</main>`;
  assert.equal(inspectZjoocQuestionPage(frame).snapshot.scene, 'exam');
  const command = writeCommand(frame, { choices: ['option-1'] });
  win.history.pushState({}, '', '/ucenter/student/exam/another-paper');
  const result = await handleAnswerPageCommand(frame, command);
  assert.equal(result.ok, false);
  dom.window.close();
});

test('a completed parent exam makes its embedded questions read-only', () => {
  const { dom, win } = fixture('<div class="exam-status">已交卷</div><iframe id="paper-frame"></iframe>');
  const frame = win.document.querySelector<HTMLIFrameElement>('#paper-frame')!.contentWindow!;
  frame.document.body.innerHTML = `<main class="exam-paper">${question()}</main>`;
  const page = inspectZjoocQuestionPage(frame);
  assert.equal(page.snapshot.complete, true);
  assert.equal(readQuestionControl(frame, page.entries[0]).ready, false);
  dom.window.close();
});
