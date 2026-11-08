import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { inspectZjoocQuestionPage } from '../src/features/question-answer/adapters/zjooc';
import { readQuestionControl } from '../src/features/question-answer/adapters/chaoxing';
import { handleAnswerPageCommand } from '../src/features/question-answer/page';
import { createQuestionAnswerController } from '../src/features/question-answer/controller';
import { readPageContext } from '../src/platform/page-context';
import { isQuestionSnapshot, isPreparedQuestion } from '../src/features/question-answer/protocol';
import { createQuestionResultsFile } from '../src/features/question-answer/export';
import { bankCourseContext } from '../src/features/local-question-bank/library-types';
import type { AnswerRuntime } from '../src/features/question-answer/client';
import type { AnswerSourcesStatus, AnswerResult, ApplicableAnswer, QuestionSnapshot } from '../src/features/question-answer/types';

const reviewHtml = readFileSync(new URL('./fixtures/zjooc-review.html', import.meta.url), 'utf8');
const address = 'https://www.zjooc.cn/ucenter/student/exam/sample';
const sources: AnswerSourcesStatus = { selection: 'ai', bank: { configured: false, authorized: false }, ai: { configured: true, authorized: true, enabled: true } };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));
async function until(check: () => boolean) { for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); } throw new Error('condition timed out'); }

test('captured review structure reads 26 distinct questions, metadata and SQL without enabling writes', async () => {
  const dom = new JSDOM(reviewHtml, { url: 'https://www.zjooc.cn/ucenter/student/unknown-review' });
  const win = dom.window as unknown as Window;
  try {
    const page = inspectZjoocQuestionPage(win);
    assert.equal(readPageContext(win.document), 'exam');
    assert.equal(page.snapshot.complete, true); assert.equal(page.snapshot.allLoaded, true);
    assert.equal(page.snapshot.canSave, false); assert.equal(page.snapshot.canSubmit, false);
    assert.equal(page.entries.length, 26); assert.equal(new Set(page.entries.map(entry => entry.snapshot.key)).size, 26);
    assert.equal(page.entries.filter(entry => entry.snapshot.kind === 'single').length, 16);
    assert.equal(page.entries.filter(entry => entry.snapshot.kind === 'judgement').length, 10);
    assert.match(page.entries[0].snapshot.stem, /^1\.1 SELECT A >= 0 AND A <= 100，LIKE '_c%'/);
    assert.doesNotMatch(page.entries[0].snapshot.stem, /我的答案|平台解析|5分/);
    assert.equal(page.entries.filter(entry => entry.snapshot.reviewData?.explanation).length, 6);
    assert.ok(page.entries.every(entry => isQuestionSnapshot(entry.snapshot) && !readQuestionControl(win, entry).ready));
    assert.deepEqual(readQuestionControl(win, page.entries[16]).answer, { choices: ['option-2'] });
    const q = page.entries[0].snapshot;
    assert.equal(isPreparedQuestion({ question: q, images: [], suggestionTitle: '', suggestionOptions: '' }), false);
    let clicks = 0; win.document.querySelectorAll('button,input,label').forEach(node => node.addEventListener('click', () => clicks++));
    const result = await handleAnswerPageCommand(win, { action: 'write', documentKey: page.snapshot.documentKey, scopeKey: page.snapshot.scopeKey,
      key: q.key, fingerprint: q.fingerprint, expectedVersion: 'ignored', answer: { choices: ['option-1'] }, replace: true });
    assert.equal(result.ok, false); assert.equal(clicks, 0);
  } finally { dom.window.close(); }
});

test('hidden review copies do not enable an exam workspace; visible incomplete groups are not a full paper', () => {
  const dom = new JSDOM(reviewHtml, { url: 'https://www.zjooc.cn/ucenter/student/unknown' }); const win = dom.window as unknown as Window;
  try {
    win.document.querySelector('main')!.setAttribute('hidden', ''); assert.equal(readPageContext(win.document), 'generic');
    win.document.querySelector('main')!.removeAttribute('hidden'); win.document.querySelector('.questiono-item')!.remove();
    assert.equal(inspectZjoocQuestionPage(win).snapshot.allLoaded, false);
  } finally { dom.window.close(); }
});

function harness(readOnly = false, count = 3) {
  const questions: QuestionSnapshot[] = Array.from({ length: count }, (_, i) => ({ key: `q${i}`, fingerprint: `fp${i}`, number: String(i + 1), kind: 'single', stem: `问题 ${i}`,
    options: [{ id: 'a', label: 'A', text: '甲' }, { id: 'b', label: 'B', text: '乙' }], fields: [], children: [], images: [], supported: true,
    ...(readOnly ? { reviewData: { answer: { choices: ['b'] }, score: '1', maxScore: '1', explanation: '回看解析' } } : {}) }));
  const answers: ApplicableAnswer[] = questions.map(() => readOnly ? { choices: ['b'] } : {});
  const calls = { generated: [] as string[], commands: [] as string[], proofs: [] as unknown[] };
  let invalidated: (() => void) | undefined;
  let generator: (q: QuestionSnapshot, signal: AbortSignal) => Promise<AnswerResult> = async () => ({ status: 'answer', source: 'ai', text: '参考甲', answer: { choices: ['a'] } });
  let status = structuredClone(sources);
  const runtime: AnswerRuntime = {
    scan: async () => [{ frameId: 0, snapshot: { documentKey: 'doc', scopeKey: 'paper', scene: 'exam', questions: structuredClone(questions), complete: readOnly, allLoaded: false, canSave: false, canSubmit: false } }],
    page: async (target, command, _signal, proof) => {
      calls.commands.push(command.action);
      const index = questions.findIndex(q => q.key === target.question.key);
      if (questions[index].fingerprint !== target.question.fingerprint) return { ok: false, error: '题目已变化' };
      if (command.action === 'write') { assert.equal(readOnly, false); calls.proofs.push(proof); answers[index] = structuredClone(command.answer); }
      return { ok: true, control: { ready: !readOnly, version: JSON.stringify(answers[index]), hasContent: Boolean(answers[index].choices?.length), complete: Boolean(answers[index].choices?.length), answer: structuredClone(answers[index]) } };
    }, cancel() {}, subscribeInvalidation(listener) { invalidated = listener; return () => { invalidated = undefined; }; },
  };
  const controller = createQuestionAnswerController({ runtime, isEnabled: () => true, getSources: async () => structuredClone(status), saveSource: async () => {},
    generate: async (prepared, _source, signal) => { assert.equal(prepared.question.reviewData, undefined); calls.generated.push(prepared.question.key); return generator(prepared.question, signal); } });
  return { controller, questions, answers, calls, invalidate: () => invalidated?.(), setStatus: (value: AnswerSourcesStatus) => { status = value; },
    setGenerator: (value: typeof generator) => { generator = value; },
    async preview() { controller.preview(); await until(() => controller.getState().rows.length === count && !controller.getState().previewing); },
    async done() { await until(() => !controller.getState().running && ['complete', 'error', 'paused'].includes(controller.getState().phase)); },
  };
}

test('read-only completed papers can batch search while retaining page answers and never issuing mutations', async () => {
  const h = harness(true);
  try {
    await h.preview(); assert.equal(h.controller.getState().mode, 'search'); h.controller.start(); await h.done();
    assert.equal(h.calls.generated.length, 3); assert.ok(h.controller.getState().rows.every(row => row.phase === 'searched' && row.readOnly));
    assert.deepEqual(h.answers, [{ choices: ['b'] }, { choices: ['b'] }, { choices: ['b'] }]);
    assert.ok(h.calls.commands.every(command => command === 'read'));
    const json = JSON.parse(createQuestionResultsFile(h.controller.getState(), 'json', '样本').content);
    assert.equal(json.items[0].platformReview.explanation, '回看解析'); assert.equal(json.items[0].result.text, 'A · 甲'); assert.equal(json.items[0].pageAnswer.text, 'B · 乙');
    assert.equal(h.questions[0].reviewData?.explanation, '回看解析');
  } finally { h.controller.dispose(); }
});

test('current and forward ranges search exactly the selected rows; repeated starts reuse complete results', async () => {
  const h = harness();
  try {
    await h.preview(); h.controller.setMode!('search'); h.controller.selectQuestion!(h.controller.getState().rows[1].id); h.controller.setRange!('forward');
    h.controller.start(); await h.done(); assert.deepEqual(h.calls.generated, ['q1', 'q2']);
    h.controller.start(); await h.done(); assert.deepEqual(h.calls.generated, ['q1', 'q2']);
    h.controller.selectQuestion!(h.controller.getState().rows[0].id); h.controller.setRange!('current'); h.controller.start(); await h.done();
    assert.deepEqual(h.calls.generated, ['q1', 'q2', 'q0']); assert.ok(h.calls.commands.every(command => command === 'read'));
  } finally { h.controller.dispose(); }
});

test('searching an answered question does not overwrite it; applying a result needs explicit replace and reuses the result', async () => {
  const h = harness(false, 1); h.answers[0] = { choices: ['b'] };
  try {
    await h.preview(); const id = h.controller.getState().rows[0].id; h.controller.search!(id); await h.done();
    assert.deepEqual(h.answers[0], { choices: ['b'] }); h.controller.applyResult!(id); await h.done(); assert.deepEqual(h.answers[0], { choices: ['b'] });
    h.controller.applyResult!(id, true); await h.done(); assert.deepEqual(h.answers[0], { choices: ['a'] }); assert.equal(h.calls.generated.length, 1);
  } finally { h.controller.dispose(); }
});

test('a manual edit after searching is preserved even if a stale replace action is invoked', async () => {
  const h = harness(false, 1);
  try {
    await h.preview(); const id = h.controller.getState().rows[0].id; h.controller.search!(id); await h.done();
    h.answers[0] = { choices: ['b'] }; h.controller.applyResult!(id, true); await h.done();
    assert.deepEqual(h.answers[0], { choices: ['b'] }); assert.ok(!h.calls.commands.includes('write')); assert.match(h.controller.getState().message, /已变化/);
  } finally { h.controller.dispose(); }
});

test('pausing a delayed search ignores late answers and continues the original range without repeating completed requests', async () => {
  const h = harness(); let release: ((result: AnswerResult) => void) | undefined;
  h.setGenerator(async q => q.key === 'q1' ? new Promise(resolve => { release = resolve; }) : { status: 'answer', source: 'ai', text: '甲', answer: { choices: ['a'] } });
  try {
    await h.preview(); h.controller.setMode!('search'); h.controller.start(); await until(() => Boolean(release));
    h.controller.stop(); release!({ status: 'answer', source: 'ai', text: '迟到', answer: { choices: ['a'] } }); await h.done();
    assert.equal(h.controller.getState().rows[0].phase, 'searched'); assert.equal(h.controller.getState().rows[1].resultAnswer, undefined);
    h.setGenerator(async () => ({ status: 'answer', source: 'ai', text: '甲', answer: { choices: ['a'] } }));
    h.controller.selectQuestion!(h.controller.getState().rows[2].id); h.controller.start(); await h.done();
    assert.deepEqual(h.calls.generated, ['q0', 'q1', 'q1', 'q2']); assert.ok(!h.calls.commands.includes('write'));
  } finally { h.controller.dispose(); }
});

test('local proof is retained for later application; settings/deletion invalidates old results without clearing page answers', async () => {
  const h = harness(false, 1); const proof = { revision: 3, libraryIds: ['lib'], entryIds: ['entry'], context: 'course' };
  h.setGenerator(async () => ({ status: 'answer', source: 'local-bank', text: '甲', answer: { choices: ['a'] }, localProof: proof }));
  try {
    await h.preview(); const id = h.controller.getState().rows[0].id; h.controller.search!(id); await h.done();
    h.controller.applyResult!(id); await h.done(); assert.deepEqual(h.calls.proofs, [proof]);
    h.controller.settingsChanged(); assert.equal(h.controller.getState().rows[0].resultApplicable, false);
    h.controller.applyResult!(id, true); await tick(); assert.deepEqual(h.calls.proofs, [proof]); assert.deepEqual(h.answers[0], { choices: ['a'] });
    const exported = createQuestionResultsFile(h.controller.getState(), 'json', '题目').content; assert.doesNotMatch(exported, /libraryIds|entryIds|localProof/);
  } finally { h.controller.dispose(); }
});

test('source changes and paper invalidation prevent reusing or applying stale results', async () => {
  const h = harness(false, 1);
  try {
    await h.preview(); const id = h.controller.getState().rows[0].id; h.controller.search!(id); await h.done();
    h.setStatus({ ...sources, selection: 'bank', bank: { configured: true, authorized: true } }); h.controller.refreshSources(); await until(() => h.controller.getState().source === 'bank');
    assert.equal(h.controller.getState().rows[0].resultApplicable, false); h.invalidate(); h.controller.applyResult!(id);
    assert.equal(h.controller.getState().previewStale, true); assert.ok(!h.calls.commands.includes('write'));
  } finally { h.controller.dispose(); }
});

test('manual exam library selections are separated by page and ignore authentication queries', () => {
  assert.notEqual(bankCourseContext(address), bankCourseContext(`${address}-other`));
  assert.equal(bankCourseContext(address), bankCourseContext(`${address}?enc=secret&token=secret`));
  assert.doesNotMatch(bankCourseContext(`${address}?enc=secret`), /secret|sample|https/);
});
