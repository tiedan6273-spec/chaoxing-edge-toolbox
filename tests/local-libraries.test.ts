import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { zipSync, strToU8 } from 'fflate';
import { parseBankTemplate, sampleBankTemplate, serializeBankTemplate } from '../src/features/local-question-bank/template';
import { createLocalBankRepository } from '../src/features/local-question-bank/repository';
import { decodeBankText, docxParagraphText, inspectBankDocx, reconstructPdfPage } from '../src/features/local-question-bank/file-extract';
import { bankCourseContext, type LibraryInput, type LocalAnswerProof } from '../src/features/local-question-bank/library-types';
import { matchLocalBank } from '../src/features/local-question-bank/matching';
import { planAnswerSource } from '../src/features/question-answer/source-status';
import { createResultsTemplateFile } from '../src/features/local-question-bank/results-template';
import type { AnswerSourcesStatus, QuestionAnswerState } from '../src/features/question-answer/types';
import { bankTemplateExample } from '../src/features/local-question-bank/template-example';
import { JSDOM } from 'jsdom';
import { createAnswerExchangeView } from '../src/features/answer-exchange/ui';
import { defaultSettings } from '../src/features/toolbox-settings/types';
import type { QuestionAnswerController } from '../src/features/question-answer/types';

function input(name = '数据库'): LibraryInput {
  const draft = parseBankTemplate(sampleBankTemplate()); assert.deepEqual(draft.issues, []);
  return { name, course: '数据库原理', filename: `${name}.txt`, fileHash: '', format: 'txt', items: draft.items };
}
const repo = () => createLocalBankRepository(new IDBFactory(), crypto.randomUUID());
const status = (): AnswerSourcesStatus => ({ selection: 'local', bank: { configured: false, authorized: false }, ai: { configured: false, authorized: false, enabled: false }, local: { enabled: true, onlineFallback: false, selectedCount: 1, revision: 1 } });

test('five-kind template parses consistently and round-trips multi-line text without semantic loss', () => {
  const draft = parseBankTemplate(bankTemplateExample); assert.deepEqual(draft.issues, []); assert.equal(draft.items.length, 5);
  const round = parseBankTemplate(serializeBankTemplate(draft.items, draft.name, draft.course));
  assert.deepEqual(round.issues, []);
  assert.deepEqual(round.items.map(e => [e.record.question.stem, e.record.answer, e.explanation]), draft.items.map(e => [e.record.question.stem, e.record.answer, e.explanation]));
  assert.match(round.items[4].record.answer.texts![0], /\n/);
});
test('syntax errors, missing blocks, wrong counts, bad answers and repeated fields never become valid imports', () => {
  for (const value of [sampleBankTemplate().replace('题目总数：1', '题目总数：2'), sampleBankTemplate().replace('【结束】', ''),
    sampleBankTemplate().replace('答案：A', '答案：Z'), sampleBankTemplate().replace('题型：单选', '题型：单选\n题型：多选'), sampleBankTemplate().replace('解析：', '答按：')]) {
    assert.ok(parseBankTemplate(value).issues.length > 0);
  }
});
test('escaped structural lines and literal backslashes survive template round-trip', () => {
  const value = input(); value.items[0].record.question.stem = '答案：作为题干\n【结束】\nC:\\data';
  const round = parseBankTemplate(serializeBankTemplate(value.items, '转义'));
  assert.deepEqual(round.issues, []); assert.equal(round.items[0].record.question.stem, value.items[0].record.question.stem);
});
test('same-content different answers survive as conflicts; equivalent records deduplicate within one library', async () => {
  const value = input(); const same = structuredClone(value.items[0]); same.number = '2';
  const other = structuredClone(value.items[0]); other.number = '3'; other.record.answer = { choices: ['option-B'] };
  value.items.push(same, other); const store = repo(); await store.migrate([]);
  const { library } = await store.importLibrary(value); assert.equal(library.count, 2); assert.equal(library.conflicts, 1);
  const match = await store.match(value.items[0].record.question, [library.id]); assert.equal(match.status, 'conflict'); await store.close();
});
test('library deletion is scoped, persists across reopen, invalidates proofs and cannot resurrect migrated data', async () => {
  const factory = new IDBFactory(); const name = crypto.randomUUID(); const store = createLocalBankRepository(factory, name); const value = input();
  await store.migrate([value.items[0].record]);
  const { library } = await store.importLibrary(value); await store.preferences('chaoxing:123', { enabled: true, onlineFallback: false, libraryIds: [library.id] });
  const match = await store.match(value.items[0].record.question, [library.id]);
  const proof: LocalAnswerProof = { revision: match.revision, context: 'chaoxing:123', libraryIds: [library.id], entryIds: match.sources.map(s => s.entryId) };
  assert.equal(await store.validate(proof), true);
  await store.remove(library.id); assert.equal(await store.validate(proof), false);
  assert.equal((await store.match(value.items[0].record.question, [library.id])).status, 'missing');
  assert.equal((await store.state()).total, 1); // The independent legacy library survives.
  await store.remove('legacy-bank'); await store.close();
  const reopened = createLocalBankRepository(factory, name); await reopened.migrate([value.items[0].record]);
  assert.equal((await reopened.state()).total, 0); await reopened.close();
});
test('disabling a library and deleting a single entry removes matches without touching another library', async () => {
  const store = repo(); await store.migrate([]); const value = input();
  const a = (await store.importLibrary(value)).library; const b = (await store.importLibrary(input('另一个库'))).library;
  await store.update(a.id, { enabled: false }); assert.equal((await store.match(value.items[0].record.question, [a.id])).status, 'missing');
  assert.equal((await store.match(value.items[0].record.question, [b.id])).status, 'matched');
  const entries = await store.entries(b.id); await store.remove(b.id, [entries[0].id]);
  assert.equal((await store.entries(a.id)).length, 1); assert.equal((await store.entries(b.id)).length, 0); await store.close();
});
test('duplicate file imports are idempotent and failed import transactions do not leave partial libraries', async () => {
  const store = repo(); await store.migrate([]); const value = input(); value.fileHash = 'same-file';
  assert.equal((await store.importLibrary(value)).duplicate, false); assert.equal((await store.importLibrary(value)).duplicate, true);
  const bad = input(); bad.name = ''; await assert.rejects(store.importLibrary(bad));
  assert.equal((await store.state()).libraries.length, 1); assert.equal((await store.entries()).length, 1); await store.close();
});
test('preferences are isolated by course, do not select new libraries and omit unknown IDs', async () => {
  const store = repo(); await store.migrate([]); const lib = (await store.importLibrary(input())).library;
  await store.preferences('zjooc:123', { enabled: true, onlineFallback: true, libraryIds: [lib.id, 'deleted'] });
  assert.deepEqual((await store.state('zjooc:123')).preferences.libraryIds, [lib.id]);
  assert.equal((await store.state('zjooc:456')).preferences.enabled, false);
  await store.importLibrary(input('新库')); assert.deepEqual((await store.state('zjooc:123')).preferences.libraryIds, [lib.id]); await store.close();
});
test('exact matching remaps reordered choices, preserves negation and handles true/false labels semantically', () => {
  const original = input().items[0].record; const q = structuredClone(original.question);
  q.options.reverse(); q.options.forEach((option, i) => { option.id = `page-${i}`; option.label = String.fromCharCode(65 + i); });
  const result = matchLocalBank(q, [original]); assert.equal(result.status, 'matched'); assert.deepEqual(result.answer, { choices: ['page-1'] });
  q.stem = q.stem.replace('哪一项是', '哪一项不是'); assert.equal(matchLocalBank(q, [original]).status, 'missing');
  const judgement = parseBankTemplate(sampleBankTemplate().replace('题型：单选', '题型：判断').replace(/选项：[\s\S]*?答案：A/, '答案：正确')).items[0].record;
  const live = structuredClone(judgement.question); live.options = [{ id: 'no', label: 'A', text: '错' }, { id: 'yes', label: 'B', text: '对' }];
  assert.deepEqual(matchLocalBank(live, [judgement]).answer, { choices: ['yes'] });
});
test('local-only preflight requires no API and cannot silently enable online fallback', () => {
  const local = status(); assert.equal(planAnswerSource('local', local).first, 'local'); assert.equal(planAnswerSource('local', local).fallback, false);
  assert.equal(planAnswerSource('ai', local).first, 'local'); assert.equal(planAnswerSource('ai', local).fallback, false);
  local.local!.selectedCount = 0; assert.equal(planAnswerSource('ai', local).first, undefined);
});
test('stable context keys discard login tokens and keep platforms separate', () => {
  assert.equal(bankCourseContext('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=123&enc=secret'), 'chaoxing:123');
  assert.equal(bankCourseContext('https://www.zjooc.cn/ucenter/student/course/study/abc/plan/detail/def'), 'zjooc:abc');
  assert.equal(bankCourseContext('https://evilchaoxing.com/?courseId=123'), 'manager');
});
test('text decoding fails visibly on unsupported encoding and accepts UTF-8 BOM', () => {
  assert.match(decodeBankText(new TextEncoder().encode(sampleBankTemplate())).text, /CXQB-1/);
  assert.throws(() => decodeBankText(new Uint8Array([0xff, 0xfe, 0x00])), /编码/);
});
test('DOCX preflight rejects drawings, automatic numbering and inflated file size', () => {
  assert.deepEqual(docxParagraphText('第一段\n\n第二段第一行\n第二行\n\n').locations, ['DOCX 段落 1', 'DOCX 段落 2', 'DOCX 段落 2', 'DOCX 段落 3']);
  for (const tag of ['<w:drawing/>', '<w:tbl/>', '<m:oMath/>', '<w:numPr/>']) {
    assert.throws(() => inspectBankDocx(zipSync({ 'word/document.xml': strToU8(`<w:document>${tag}</w:document>`) })), /图片|公式|自动编号/);
  }
  inspectBankDocx(zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:r><w:t>题干</w:t></w:r></w:p></w:document>') }));
  assert.throws(() => inspectBankDocx(zipSync({ 'word/document.xml': new Uint8Array(12_000_001) })), /过大/);
});
test('PDF reconstruction restores geometric line order and refuses scanned, multi-column and rotated text', () => {
  const item = (str: string, x: number, y: number) => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 10, height: 10 });
  const result = reconstructPdfPage([item('答案：A', 20, 100), item('题干：数据库', 20, 120)], 2);
  assert.equal(result.text, '题干：数据库\n答案：A'); assert.match(result.locations[0], /第 2 页/);
  assert.throws(() => reconstructPdfPage([], 3), /扫描/);
  assert.throws(() => reconstructPdfPage([item('左栏', 20, 100), item('右栏', 300, 100)], 1), /多栏/);
  assert.equal(reconstructPdfPage([item('A.', 20, 100), item(' ', 40, 100), item('MySQL', 50, 100)], 1).text, 'A. MySQL');
  assert.throws(() => reconstructPdfPage([{ ...item('旋转', 20, 100), transform: [0, 10, -10, 0, 20, 100] }], 1), /旋转/);
});
test('a 2000-question library is queryable and an over-limit transaction is rejected without partial writes', async () => {
  const store = repo(); await store.migrate([]); const value = input(); const sample = value.items[0];
  value.items = Array.from({ length: 2000 }, (_, i) => {
    const entry = structuredClone(sample); entry.number = String(i + 1); entry.record.question.stem += `（样本 ${i + 1}）`; return entry;
  });
  const library = (await store.importLibrary(value)).library;
  assert.equal(library.count, 2000);
  assert.equal((await store.match(value.items[1999].record.question, [library.id])).status, 'matched');
  await assert.rejects(store.importLibrary(input('超额')), /最多 2000/);
  assert.equal((await store.state()).total, 2000); assert.equal((await store.state()).libraries.length, 1); await store.close();
});
test('result template export requires complete chosen answers and round-trips without private page metadata', () => {
  const q = input().items[0].record.question; const state: QuestionAnswerState = { phase: 'complete', running: false, source: 'local', message: '', rows: [
    { id: 'private-row', target: { frameId: 0, documentKey: 'secret', scopeKey: 'token', question: q }, phase: 'filled', text: '', message: '', resultAnswer: { choices: ['option-A'] }, currentAnswer: { choices: ['option-B'] } },
  ] };
  const result = parseBankTemplate(createResultsTemplateFile(state, 'result', '结果').content); assert.deepEqual(result.issues, []);
  assert.deepEqual(result.items[0].record.answer, { choices: ['option-A'] });
  assert.deepEqual(parseBankTemplate(createResultsTemplateFile(state, 'page', '页面').content).items[0].record.answer, { choices: ['option-B'] });
  assert.doesNotMatch(createResultsTemplateFile(state, 'result', '结果').content, /secret|token|private-row/);
  state.previewStale = true; assert.throws(() => createResultsTemplateFile(state, 'result', '结果'), /页面已经变化/);
});

test('a library change invalidates a legacy match read that resolves after deletion', async () => {
  const dom = new JSDOM('<body/>', { url: 'https://www.zjooc.cn/ucenter/student/homework/qa' });
  const previous = { document: globalThis.document, AbortController: globalThis.AbortController };
  Object.assign(globalThis, { document: dom.window.document, AbortController: dom.window.AbortController });
  const record = input().items[0].record;
  const state: QuestionAnswerState = { phase: 'idle', running: false, source: 'local', message: '', rows: [{ id: 'r1',
    target: { frameId: 0, documentKey: 'doc', scopeKey: 'scope', question: record.question }, phase: 'pending', text: '', message: '' }] };
  let changed = () => {}; let release!: (value: typeof record[]) => void;
  const read = new Promise<typeof record[]>(resolve => { release = resolve; });
  const controller = { getState: () => state, subscribe(listener: (state: QuestionAnswerState) => void) { listener(state); return () => {}; }, applyImportedAnswers: async () => {} } as unknown as QuestionAnswerController;
  let view: ReturnType<typeof createAnswerExchangeView> | undefined;
  try {
    view = createAnswerExchangeView({ controller, bank: { read: () => read, save: async () => ({ added: 0, total: 0 }), clear: async () => {} }, subscribeBank(listener) { changed = listener; return () => {}; } });
    dom.window.document.body.append(view.element); view.update(defaultSettings(), false);
    const match = [...view.element.querySelectorAll('button')].find(button => button.textContent === '匹配当前题目')!;
    assert.equal(match.disabled, false); match.click(); changed(); release([record]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((view.element.querySelector('.answer-exchange-preview') as HTMLElement).hidden, true);
    assert.match(view.element.textContent!, /已取消旧匹配预览/);
  } finally { view?.dispose(); Object.assign(globalThis, previous); dom.window.close(); }
});
