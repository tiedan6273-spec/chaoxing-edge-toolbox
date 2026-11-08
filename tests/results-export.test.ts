import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { collectQuestionResults, createQuestionResultsFile, type ResultsExportFile } from '../src/features/question-answer/export';
import { createResultsExportView, downloadResultsFile } from '../src/features/question-answer/export-ui';
import { createQuestionAnswerController } from '../src/features/question-answer/controller';
import type { AnswerRow, ApplicableAnswer, QuestionAnswerState, QuestionSnapshot } from '../src/features/question-answer/types';

const now = new Date('2026-11-07T12:34:56.000Z');
function question(kind: QuestionSnapshot['kind'] = 'single'): QuestionSnapshot {
  return { key: 'q1', fingerprint: 'v1', number: '2', kind, stem: '下列哪项属于数据库？', supported: true,
    options: [{ id: 'sql', label: 'A', text: 'MySQL' }, { id: 'text', label: 'B', text: '记事本' }], fields: [], children: [], images: [] };
}
function row(value: Partial<AnswerRow> = {}, q = question()): AnswerRow {
  return { id: `row-${q.key}`, target: { frameId: 0, documentKey: 'private-document-token', scopeKey: 'private-scope-token', question: q },
    phase: 'filled', message: '已填写并核对。', text: '{"choices":["sql"]}', source: 'ai', resultAnswer: { choices: ['sql'] }, currentAnswer: { choices: ['sql'] }, ...value };
}
function state(rows: AnswerRow[] = [row()]): QuestionAnswerState {
  return { phase: 'complete', running: false, source: 'ai', rows, message: '完成' };
}

test('TXT resolves answer IDs to labels and keeps generated, edited page and review answers distinct', () => {
  const value = state([row({ currentAnswer: { choices: ['text'] }, review: { status: 'suspect', reason: '页面答案可能有误', suggestedAnswer: { choices: ['sql'] } } })]);
  const before = structuredClone(value);
  const file = createQuestionResultsFile(value, 'txt', '数据库复习', now);
  assert.equal(file.content.charCodeAt(0), 0xfeff);
  assert.match(file.content, /第 2 题 · 单选题/);
  assert.match(file.content, /A\. MySQL/);
  assert.match(file.content, /答案来源：AI/);
  assert.match(file.content, /获取的答案：\r\nA · MySQL/);
  assert.match(file.content, /页面答案：\r\nB · 记事本/);
  assert.match(file.content, /AI 复检（建议，待核对）/);
  assert.match(file.content, /已填写不代表平台已保存或答案正确/);
  assert.deepEqual(value, before);
});

test('JSON contains structured question results and excludes private page routing identities and inline image bytes', () => {
  const q = question(); q.images = ['data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==', 'https://example.org/diagram.png'];
  const file = createQuestionResultsFile(state([row({}, q)]), 'json', '题目备份', now);
  const data = JSON.parse(file.content);
  assert.equal(data.kind, 'question-results'); assert.equal(data.scope, 'loaded-questions');
  assert.equal(data.exportedAt, now.toISOString()); assert.equal(data.withResults, 1);
  assert.deepEqual(data.items[0].result.value, { choices: ['sql'] });
  assert.equal(data.items[0].question.options[0].text, 'MySQL');
  assert.match(data.items[0].question.images[0], /原页面/);
  assert.equal(data.items[0].question.images[1], q.images[1]);
  assert.doesNotMatch(file.content, /private-document-token|private-scope-token|cHJpdmF0ZS1pbWFnZQ/);
  data.items[0].result.value.choices[0] = 'changed';
  assert.deepEqual(q.options[0].id, 'sql');
});

test('pending, partial and no-answer results are exported with their state rather than invented answers', () => {
  const value = state([
    row({ id: 'pending', phase: 'pending', source: undefined, resultAnswer: undefined, currentAnswer: undefined, text: '' }),
    row({ id: 'streaming', phase: 'querying', resultAnswer: undefined, currentAnswer: undefined, text: '{"choi' }),
    row({ id: 'missing', phase: 'needs-review', resultAnswer: undefined, currentAnswer: undefined, text: '{"unanswerable":true}' }),
  ]);
  value.running = true;
  const data = collectQuestionResults(value, '课程', now);
  assert.equal(data.total, 3); assert.equal(data.withResults, 0);
  assert.equal(data.items[0].result, undefined);
  assert.equal(data.items[1].unfinishedResult?.complete, false);
  const text = createQuestionResultsFile(value, 'txt', '课程', now).content;
  assert.match(text, /获取中（结果未完成）/); assert.match(text, /尚未获取可用答案/);
  assert.match(text, /导出时任务仍在处理/);
});

test('text, program, matching and reading answers retain line breaks and resolve their own option sets', () => {
  const text = question('completion'); text.fields = [{ id: 'blank1' }, { id: 'blank2' }];
  const program = question('program'); program.program = { language: 'C' };
  const line = question('line'); line.fields = [{ id: 'f1', options: [{ id: 'match', label: 'C', text: '第三范式' }] }];
  const reader = question('reader'); reader.children = [{ id: 'sub', stem: '子题题干', options: [{ id: 'child-b', label: 'B', text: '子题正确项' }] }];
  const entries = [[text, { texts: ['原子性', '隔离性\n补充说明'] }], [program, { code: 'int main() {\n  return 0;\n}' }],
    [line, { matches: ['match'] }], [reader, { children: [{ id: 'sub', choices: ['child-b'] }] }]] as Array<[QuestionSnapshot, ApplicableAnswer]>;
  const content = createQuestionResultsFile(state(entries.map(([q, answer]) => row({ resultAnswer: answer, currentAnswer: undefined }, q))), 'txt', '综合题', now).content;
  assert.match(content, /第 2 空：隔离性\r\n补充说明/);
  assert.match(content, /int main\(\) \{\r\n {2}return 0;/);
  assert.match(content, /第 1 项：C · 第三范式/);
  assert.match(content, /子题 1：B · 子题正确项/);
  assert.match(content, /编程语言：C/);
});

test('a page change is explicitly labelled and cannot give old results a new page title', () => {
  const value = state(); value.previewStale = true;
  const file = createQuestionResultsFile(value, 'json', '另一张试卷', now);
  const data = JSON.parse(file.content);
  assert.equal(data.pageChanged, true); assert.equal(data.title, '上次页面保留的题目与答案');
  assert.doesNotMatch(file.name, /另一张试卷/);
});

test('empty exports fail clearly and filenames are safe on Windows', () => {
  assert.throws(() => createQuestionResultsFile(state([]), 'txt', '空', now), /先识别/);
  const file = createQuestionResultsFile(state(), 'txt', '课程/练习:"第2章"?\n', now);
  assert.doesNotMatch(file.name, /[<>:"/\\|?*\r\n]/);
  assert.ok(file.name.endsWith('.txt'));
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for answer controller');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('a completed provider result survives a failed page write, preview refresh and a later manual page edit', async () => {
  let pageAnswer: ApplicableAnswer = {};
  const q = question();
  const controller = createQuestionAnswerController({ isEnabled: () => true, watchInterval: 10_000,
    runtime: { scan: async () => [{ frameId: 0, snapshot: { documentKey: 'doc', scopeKey: 'scope', scene: 'homework', questions: [q], complete: false, allLoaded: true, canSave: false, canSubmit: false } }],
      page: async (_target, command) => command.action === 'write' ? { ok: false, error: '页面暂不可写' }
        : { ok: true, control: { ready: true, version: 'v1', hasContent: Boolean(pageAnswer.choices?.length), complete: Boolean(pageAnswer.choices?.length), answer: structuredClone(pageAnswer) } },
      cancel() {}, },
    getSources: async () => ({ selection: 'ai', bank: { configured: false, authorized: false }, ai: { enabled: true, configured: true, authorized: true } }), saveSource: async () => {},
    generate: async () => ({ status: 'answer', source: 'ai', text: '{"choices":["sql"]}', answer: { choices: ['sql'] } }),
  });
  try {
    controller.start();
    await until(() => !controller.getState().running && controller.getState().rows[0]?.phase === 'error');
    assert.deepEqual(controller.getState().rows[0].resultAnswer, { choices: ['sql'] });
    pageAnswer = { choices: ['text'] }; controller.preview();
    await until(() => !controller.getState().previewing && controller.getState().rows[0]?.currentAnswer?.choices?.[0] === 'text');
    const output = collectQuestionResults(controller.getState(), '课程', now).items[0];
    assert.equal(output.result?.text, 'A · MySQL'); assert.equal(output.pageAnswer?.text, 'B · 记事本');
  } finally { controller.dispose(); }
});

test('a changed question fingerprint discards the old generated result before export', async () => {
  const q = question();
  const controller = createQuestionAnswerController({ isEnabled: () => true, watchInterval: 10_000,
    runtime: { scan: async () => [{ frameId: 0, snapshot: { documentKey: 'doc', scopeKey: 'scope', scene: 'homework', questions: [structuredClone(q)], complete: false, allLoaded: true, canSave: false, canSubmit: false } }],
      page: async (_target, command) => command.action === 'write' ? { ok: false, error: '暂不可写' } : { ok: true, control: { ready: true, version: 'v1', hasContent: false, complete: false, answer: {} } }, cancel() {} },
    getSources: async () => ({ selection: 'ai', bank: { configured: false, authorized: false }, ai: { enabled: true, configured: true, authorized: true } }), saveSource: async () => {},
    generate: async () => ({ status: 'answer', source: 'ai', text: '答案', answer: { choices: ['sql'] } }),
  });
  try {
    controller.start(); await until(() => !controller.getState().running && Boolean(controller.getState().rows[0]?.resultAnswer));
    q.fingerprint = 'different'; q.stem = '已换成另一道题'; controller.preview();
    await until(() => !controller.getState().previewing && controller.getState().rows[0]?.target.question.fingerprint === 'different');
    assert.equal(controller.getState().rows[0].resultAnswer, undefined);
  } finally { controller.dispose(); }
});

function uiFixture() {
  const dom = new JSDOM('<title>数据库复习</title><body></body>');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousAbort = Object.getOwnPropertyDescriptor(globalThis, 'AbortController');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: dom.window.AbortController });
  let value = state(); let reads = 0; let fail = false;
  const files: ResultsExportFile[] = [];
  const view = createResultsExportView({ getState() { reads++; return structuredClone(value); }, download(file) { if (fail) throw new Error('下载被阻止'); files.push(file); } });
  dom.window.document.body.append(view.element); view.update(value, true);
  return { dom, view, files, reads: () => reads,
    set(next: QuestionAnswerState) { value = next; view.update(next, true); }, fail() { fail = true; },
    close() { view.dispose(); dom.window.close();
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
      if (previousAbort) Object.defineProperty(globalThis, 'AbortController', previousAbort); else Reflect.deleteProperty(globalThis, 'AbortController'); },
  };
}

test('changing export format has no action; click exports a fresh snapshot without starting or stopping work', () => {
  const fixture = uiFixture();
  try {
    const select = fixture.view.element.querySelector('select')!;
    select.value = 'json'; select.dispatchEvent(new fixture.dom.window.Event('change'));
    assert.equal(fixture.reads(), 0); assert.equal(fixture.files.length, 0);
    fixture.set(state([row({ resultAnswer: { choices: ['text'] } })]));
    fixture.view.element.querySelector('button')!.click();
    assert.equal(fixture.reads(), 1); assert.equal(fixture.files.length, 1);
    assert.equal(JSON.parse(fixture.files[0].content).items[0].result.text, 'B · 记事本');
    assert.match(fixture.view.element.textContent!, /已发起 1 题/);
  } finally { fixture.close(); }
});

test('export errors are visible and a disabled export cannot create a file', () => {
  const fixture = uiFixture();
  try {
    fixture.fail(); fixture.view.element.querySelector('button')!.click();
    assert.match(fixture.view.element.textContent!, /导出失败：下载被阻止/);
    fixture.view.update(state(), false); fixture.view.element.querySelector('button')!.click();
    assert.equal(fixture.reads(), 1); assert.equal(fixture.files.length, 0);
  } finally { fixture.close(); }
});

test('download uses a UTF-8 Blob and a local download link, then releases resources', () => {
  const dom = new JSDOM('<body></body>'); const doc = dom.window.document;
  const file = createQuestionResultsFile(state(), 'txt', '中文课程', now);
  let blob: Blob | undefined; let clicked = 0; let cleanup: (() => void) | undefined; const revoked: string[] = [];
  dom.window.URL.createObjectURL = value => { blob = value; return 'blob:local-test'; };
  dom.window.URL.revokeObjectURL = value => { revoked.push(value); };
  Object.defineProperty(dom.window, 'setTimeout', { value: (callback: () => void) => { cleanup = callback; return 1; } });
  dom.window.HTMLAnchorElement.prototype.click = function() { clicked++; assert.equal(this.download, file.name); assert.equal(this.href, 'blob:local-test'); };
  try {
    downloadResultsFile(file, doc);
    assert.equal(clicked, 1); assert.equal(blob?.type, 'text/plain;charset=utf-8');
    assert.equal(doc.querySelector('a'), null); assert.deepEqual(revoked, []);
    cleanup?.(); assert.deepEqual(revoked, ['blob:local-test']);
  } finally { dom.window.close(); }
});
