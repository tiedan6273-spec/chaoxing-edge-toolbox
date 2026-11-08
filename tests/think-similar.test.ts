import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAiAnswerController } from '../src/features/ai-answer/controller';
import { readThinkLadderState } from '../src/features/ai-answer/adapters/think-ladder';
import { prepareThinkLadder } from '../src/features/ai-answer/snapshot';
import { createSimilarIndex, candidateDifferences, chineseSearchTokens } from '../src/features/local-question-bank/similar';
import { createLocalBankRepository } from '../src/features/local-question-bank/repository';
import { IDBFactory } from 'fake-indexeddb';
import { buildAnswerMessages } from '../src/features/ai-answer/prompt';
import type { AiGeneratedAnswer } from '../src/features/ai-answer/types';

export const thinkHtml = '<!doctype html><div id="realApp"><div id="chatScroll"><div class="cthree"><div class="cthreecontent"><div class="dataCon"><div class="topicType">简答题</div><div class="con">简述数据库事务的特性。</div><div class="tags">知识点：数据库事务\n维度：理解 ACID</div></div></div></div></div></div><textarea id="editor"></textarea>';
function harness() {
  const dom = new JSDOM(thinkHtml, { url: 'https://mooc2-ans.chaoxing.com/mooc2-ans-vue/think-ladder/answer/pc-index?courseId=qa' });
  let value = ''; let version = 1; let valid = true; const calls = { generated: 0, writes: 0 };
  const controller = createAiAnswerController({ document: dom.window.document, isEnabled: () => true, apiConfigured: async () => true,
    readAnswer: async () => ({ ready: true, text: value, version: String(version), hasContent: Boolean(value), complete: Boolean(value) }),
    writeAnswer: async request => { if (request.expectedVersion !== String(version)) return { ok: false }; calls.writes++; value = request.text; version++; return { ok: true }; },
    generate: async (): Promise<AiGeneratedAnswer> => { calls.generated++; return { text: '原子性、一致性、隔离性和持久性。', source: 'local-bank', localProof: { context: 'qa', revision: 1, libraryIds: ['l'], entryIds: ['e'] } }; },
    validateResult: async () => valid,
  });
  return { dom, controller, calls, edit(text: string) { value = text; version++; }, invalidate() { valid = false; }, get value() { return value; }, done() { controller.dispose(); dom.window.close(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('test timeout'); }
test('think-ladder can search a locally supplied answer and apply it without a second generation', async () => {
  const h = harness(); try {
    h.controller.setMode!('search'); h.controller.start(); await until(() => h.controller.getState().phase === 'searched');
    assert.equal(h.value, ''); assert.equal(h.calls.generated, 1); h.controller.applyResult!();
    await until(() => h.controller.getState().phase === 'filled'); assert.equal(h.calls.generated, 1); assert.equal(h.calls.writes, 1);
  } finally { h.done(); }
});
test('late manual edits and invalid local references cannot be applied', async () => {
  for (const changed of ['editor', 'library']) {
    const h = harness(); try { h.controller.setMode!('search'); h.controller.start(); await until(() => h.controller.getState().phase === 'searched');
      if (changed === 'editor') h.edit('人工答案'); else h.invalidate(); h.controller.applyResult!(true);
      await until(() => h.controller.getState().phase === 'error'); assert.equal(h.calls.writes, 0);
    } finally { h.done(); }
  }
});
test('think-ladder snapshot does not drop formal stem, knowledge points or assessment hints', () => {
  const h = harness(); try { const state = readThinkLadderState(h.dom.window.document); assert.equal(state.state, 'question'); if (state.state !== 'question') return;
    assert.equal(prepareThinkLadder(state.question).question.stem, state.question.stem);
    const messages = buildAnswerMessages(state.question); assert.match(JSON.stringify(messages), /ACID/); assert.match(JSON.stringify(messages), /数据库事务/);
  } finally { h.done(); }
});
test('Chinese similar retrieval preserves critical differences and filters disabled libraries without applicable proofs', async () => {
  const h = harness(); const r = createLocalBankRepository(new IDBFactory(), crypto.randomUUID());
  try { const page = readThinkLadderState(h.dom.window.document); if (page.state !== 'question') throw new Error('fixture'); const q = prepareThinkLadder(page.question).question;
    await r.importLibrary({ name: '事务库', course: '', filename: '', fileHash: '', format: 'test', items: [{ record: { question: q, answer: { texts: ['参考答案'] } }, number: '1', kindLabel: '简答', explanation: '', position: 'test' }] });
    const state = await r.state(); const search = createSimilarIndex(await r.entries(), state.libraries); const query = { ...q, stem: '简述数据库事务不包括的特性，至少列举 2 个。' };
    const result = search(query); assert.equal(result.length, 1); assert.ok(result[0].differences.some(d => /数字/.test(d))); assert.equal('localProof' in result[0], false);
    assert.ok(chineseSearchTokens('数据库 2 <= 3').includes('数据库'.slice(0,2))); assert.ok(candidateDifferences(query, q).length);
    await r.update(state.libraries[0].id, { enabled: false }); assert.equal(createSimilarIndex(await r.entries(), (await r.state()).libraries)(q).length, 0);
  } finally { await r.close(); h.done(); }
});
