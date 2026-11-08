import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createLocalBankRepository } from '../src/features/local-question-bank/repository';
import { parseBankTemplate, sampleBankTemplate } from '../src/features/local-question-bank/template';
import type { LibraryInput, LocalAnswerProof } from '../src/features/local-question-bank/library-types';
import type { SavedQuestionInput } from '../src/features/saved-questions/types';

const input = (): LibraryInput => ({ name: '编辑样本', course: '数据库', filename: 'sample.txt', format: 'txt', fileHash: 'original', items: parseBankTemplate(sampleBankTemplate()).items });
const saved = (): SavedQuestionInput => ({ question: input().items[0].record.question, referenceAnswer: input().items[0].record.answer, source: '本地题库', course: 'chaoxing:123', wrong: false, note: '', tags: [] });
const repo = () => createLocalBankRepository(new IDBFactory(), crypto.randomUUID());

test('editing preserves ID, rejects stale windows, invalidates proofs and undo creates a new version', async () => {
  const r = repo(); await r.migrate([]); const value = input(); const { library } = await r.importLibrary(value);
  const entry = (await r.entries(library.id))[0]; await r.preferences('c', { enabled: true, libraryIds: [library.id], onlineFallback: false });
  const match = await r.match(entry.record.question, [library.id]);
  const proof: LocalAnswerProof = { revision: match.revision, context: 'c', libraryIds: [library.id], entryIds: [entry.id] };
  assert.equal(await r.validate(proof), true);
  const draft = structuredClone(value.items[0]); draft.record.answer.choices = ['option-B'];
  const edited = await r.editEntry(entry.id, 1, draft); assert.equal(edited.id, entry.id); assert.equal(edited.version, 2);
  assert.equal(await r.validate(proof), false);
  await assert.rejects(r.editEntry(entry.id, 1, value.items[0]), /其他窗口/);
  assert.deepEqual((await r.match(entry.record.question, [library.id])).answer?.choices, ['option-B']);
  const undone = await r.undoEntry(entry.id, 2); assert.equal(undone.version, 3); assert.deepEqual(undone.record.answer, entry.record.answer);
  assert.equal((await r.entryHistory(entry.id)).length, 2); assert.equal((await r.state()).libraries[0].fileHash, ''); await r.close();
});
test('invalid edits roll back all metadata and deleting a library retains independent notes', async () => {
  const r = repo(); const value = input(); const { library } = await r.importLibrary(value); const entry = (await r.entries())[0];
  const before = await r.state(); const bad = structuredClone(value.items[0]); bad.record.answer.choices = ['invalid'];
  await assert.rejects(r.editEntry(entry.id, 1, bad)); assert.equal((await r.state()).revision, before.revision); assert.equal((await r.entryHistory(entry.id)).length, 0);
  const note = await r.saveQuestion(saved()); await r.remove(library.id); assert.equal((await r.saved())[0].id, note.id); await r.close();
});
test('repeated quick-save preserves notes, wrong mark is explicit, and concurrent note edits are rejected', async () => {
  const r = repo(); const a = await r.saveQuestion(saved());
  const b = await r.saveQuestion({ ...saved(), note: '人工笔记', tags: ['数据库'] }, a.version);
  assert.equal((await r.saveQuestion(saved())).note, '人工笔记');
  assert.equal((await r.saved())[0].wrong, false);
  await r.saveQuestion({ ...saved(), wrong: true }); const c = (await r.saved())[0]; assert.equal(c.wrong, true); assert.equal(c.note, '人工笔记');
  await assert.rejects(r.saveQuestion({ ...saved(), note: '旧窗口' }, b.version), /其他窗口/);
  await r.markMastered(c.id, c.version, true); assert.equal((await r.saved())[0].mastered, true); await r.close();
});
test('full backup restores atomically and invalidates pre-restore edit versions', async () => {
  const r = repo(); const { library } = await r.importLibrary(input()); const entry = (await r.entries())[0];
  const note = await r.saveQuestion(saved()); const backup = await r.exportData();
  const broken = structuredClone(backup); broken.entries[0].libraryId = 'unknown';
  await assert.rejects(r.restoreData(broken)); assert.equal((await r.entries())[0].id, entry.id);
  await r.restoreData(backup); assert.equal((await r.state()).libraries[0].id, library.id);
  await assert.rejects(r.editEntry(entry.id, 1, input().items[0]), /其他窗口/);
  await assert.rejects(r.markMastered(note.id, note.version, true)); assert.equal((await r.saved()).length, 1); await r.close();
});
test('database v1 upgrades without recreating stores or dropping records', async () => {
  const f = new IDBFactory(); const name = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const open = f.open(name, 1);
    open.onupgradeneeded = () => { const db = open.result; db.createObjectStore('libraries', { keyPath: 'id' }); const entries = db.createObjectStore('entries', { keyPath: 'id' }); entries.createIndex('libraryId', 'libraryId'); entries.createIndex('contentKey', 'contentKey'); db.createObjectStore('meta'); };
    open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result; const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(14, 'revision'); tx.oncomplete = () => { db.close(); resolve(); }; };
  });
  const r = createLocalBankRepository(f, name); assert.equal((await r.state()).revision, 14); await r.saveQuestion(saved()); assert.equal((await r.saved()).length, 1); await r.close();
});
