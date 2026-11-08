import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { readUsage, usageCost, defaultActivitySettings, emptyLedger, budgetReason, ACTIVITY_SETTINGS, USAGE_KEY, HISTORY_KEY } from '../src/features/activity/types';
import { historyContext, questionHistoryKey, pruneHistory } from '../src/features/activity/history';
import { requestChatCompletion } from '../src/features/api-settings/model-client';
import { createQuestionAnswerController } from '../src/features/question-answer/controller';
import { diagnose } from '../src/features/activity/diagnostics';
import type { AnswerResult, ApplicableAnswer, QuestionSnapshot } from '../src/features/question-answer/types';

const question = (key = '1'): QuestionSnapshot => ({ key, fingerprint: `f${key}`, number: key, kind: 'single', stem: `第${key}题 1.1 x != 1`,
  options: [{ id: 'a', label: 'A', text: '甲' }, { id: 'b', label: 'B', text: '乙' }], fields: [], children: [], images: [], supported: true });
const answer: AnswerResult = { status: 'answer', source: 'ai', text: '参考甲', answer: { choices: ['a'] } };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2));
async function until(check: () => boolean) { for (let i = 0; i < 1500; i++) { if (check()) return; await tick(); } throw new Error('timed out'); }

test('usage counts cache inside input and reasoning inside output, rejecting malformed metrics', () => {
  const usage = readUsage({ prompt_tokens: 1000, completion_tokens: 2000, prompt_cache_hit_tokens: 400, completion_tokens_details: { reasoning_tokens: 1500 } })!;
  assert.deepEqual(usage, { input: 1000, output: 2000, cached: 400, reasoning: 1500 });
  assert.equal(usageCost(usage, { identity: '', input: 2, cached: 0.2, output: 8 }), 0.01728);
  for (const raw of [null, {}, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 2 }, { prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } }]) assert.equal(readUsage(raw), undefined);
});
test('budget requires prices, waits for in-flight work and blocks unknown or exhausted spending', () => {
  const settings = { ...defaultActivitySettings(), budget: 1 }; const ledger = emptyLedger();
  assert.match(budgetReason(settings, ledger, false)!, /价格/);
  assert.equal(budgetReason(settings, ledger, true), undefined);
  ledger.pending = ['other']; assert.match(budgetReason(settings, ledger, true)!, /一个/);
  ledger.pending = []; ledger.unknown = 1; assert.match(budgetReason(settings, ledger, true)!, /未知/);
  ledger.unknown = 0; ledger.cost = 1; assert.match(budgetReason(settings, ledger, true)!, /达到预算/);
});
test('history identity ignores auth, separates papers, preserves numeric text and option order', async () => {
  const url = 'https://www.zjooc.cn/ucenter/student/exam/paper?paperId=1';
  assert.equal(await historyContext(`${url}&token=secret`), await historyContext(`${url}&token=changed`));
  assert.notEqual(await historyContext(url), await historyContext(url.replace('paperId=1', 'paperId=2')));
  const q = question(); const same = { ...q, key: 'new-dom', fingerprint: 'new-document' };
  assert.equal(await questionHistoryKey(q), await questionHistoryKey(same));
  assert.notEqual(await questionHistoryKey(q), await questionHistoryKey({ ...q, options: [...q.options].reverse() }));
  assert.notEqual(await questionHistoryKey(q), await questionHistoryKey({ ...q, stem: q.stem.replace('!=', '=') }));
});
test('history expiry and byte limits remove old or oversized records', () => {
  const now = Date.now(); const r = { context: 'c', key: 'q', binding: 'b', at: now, result: answer };
  assert.equal(pruneHistory({ epoch: 2, records: [{ ...r, at: now - 2 * 86400000 }, r] }, 1, now).records.length, 1);
  assert.equal(pruneHistory({ epoch: 2, records: [r] }, 0, now).records.length, 0);
  const large = Array.from({ length: 650 }, (_, i) => ({ ...r, key: String(i), result: { ...answer, text: 'a'.repeat(32000) } }));
  const pruned = pruneHistory({ epoch: 2, records: large }, 7, now);
  assert.ok(new TextEncoder().encode(JSON.stringify(pruned.records)).length <= 2_000_000);
});

test('JSON and SSE report usage exactly once, including an empty-choices final event and truncated answers', async () => {
  const previous = globalThis.fetch;
  const config = { version: 1 as const, endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'fake', model: 'fake', stream: true };
  try {
    let body = '';
    globalThis.fetch = async (_url, init) => { body = String(init?.body); return new Response('data: {"choices":[{"delta":{"content":"甲"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); };
    const received: unknown[] = [];
    assert.equal(await requestChatCompletion(config, [], new AbortController().signal, undefined, { onUsage: u => received.push(u) }), '甲');
    assert.equal(received.length, 1); assert.equal(JSON.parse(body).stream_options.include_usage, true);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '不完整' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    await assert.rejects(requestChatCompletion({ ...config, stream: false }, [], new AbortController().signal, undefined, { onUsage: u => received.push(u) }), /截断/);
    assert.equal(received.length, 2); assert.deepEqual(received[1], { input: 3, output: 4, cached: 0, reasoning: 0 });
  } finally { globalThis.fetch = previous; }
});

function harness(reusable = true, delay = false) {
  const questions = [question('1'), question('2')]; const answers: ApplicableAnswer[] = [{}, {}];
  let generated = 0; let writes = 0; let release: (() => void) | undefined;
  const controller = createQuestionAnswerController({ isEnabled: () => true,
    getSources: async () => ({ selection: 'ai', bank: { configured: false, authorized: false }, ai: { configured: true, authorized: true, enabled: true } }), saveSource: async () => {},
    history: { load: async () => { if (delay) await new Promise<void>(resolve => { release = resolve; }); return [{ index: 0, result: answer, reusable, at: Date.now() }]; }, clear: async () => {} },
    generate: async () => { generated++; return structuredClone(answer); },
    runtime: { cancel() {}, scan: async () => [{ frameId: 0, snapshot: { documentKey: 'doc', scopeKey: 'scope', scene: 'exam', questions: structuredClone(questions), complete: false, allLoaded: false, canSave: false, canSubmit: false } }],
      page: async (target, command) => { const i = questions.findIndex(q => q.key === target.question.key);
        if (command.action === 'write') { writes++; answers[i] = structuredClone(command.answer); }
        return { ok: true, control: { ready: true, version: JSON.stringify(answers[i]), complete: Boolean(answers[i].choices?.length), hasContent: Boolean(answers[i].choices?.length), answer: structuredClone(answers[i]) } };
      } },
  });
  return { controller, questions, answers, calls: () => ({ generated, writes }), release: () => release?.() };
}
test('history is offered without restoration; explicit restore never writes and continuing only requests missing answers', async () => {
  const h = harness(); const c = h.controller;
  try {
    c.preview!(); await until(() => !c.getState().previewing && c.getState().history?.available === 1);
    assert.equal(c.getState().rows[0].resultAnswer, undefined); assert.deepEqual(h.calls(), { generated: 0, writes: 0 });
    c.restoreHistory!(); await until(() => c.getState().history?.busy === false);
    assert.deepEqual(h.calls(), { generated: 0, writes: 0 }); assert.deepEqual(c.getState().rows[0].resultAnswer, answer.answer);
    c.start(); await until(() => c.getState().phase === 'complete' && !c.getState().running);
    assert.deepEqual(h.calls(), { generated: 1, writes: 0 });
    const id = c.getState().rows[0].id; h.answers[0] = { choices: ['b'] }; c.applyResult!(id, true);
    await until(() => c.getState().phase === 'error' && !c.getState().running);
    assert.deepEqual(h.answers[0], { choices: ['b'] }); assert.equal(h.calls().writes, 0);
  } finally { c.dispose(); }
});
test('changed bindings restore reference-only, and a settings change cancels a late restore', async () => {
  const h = harness(false); const c = h.controller;
  try {
    c.preview!(); await until(() => c.getState().history?.available === 1); c.restoreHistory!(); await until(() => c.getState().history?.busy === false);
    assert.equal(c.getState().rows[0].resultApplicable, false); c.start(); await until(() => !c.getState().running && c.getState().phase === 'complete');
    assert.equal(h.calls().generated, 2);
  } finally { c.dispose(); }
  const late = harness(true, true);
  try {
    late.controller.preview!(); await tick(); late.release(); await until(() => late.controller.getState().history?.available === 1);
    late.controller.restoreHistory!(); await tick(); late.controller.settingsChanged(); late.release(); await tick();
    assert.equal(late.controller.getState().rows[0].resultAnswer, undefined); assert.equal(late.calls().writes, 0);
  } finally { late.controller.dispose(); }
});
test('diagnostic categories distinguish provider, resource and platform confirmation', () => {
  assert.equal(diagnose('本轮预计费用已达到预算')?.code, 'AI_BUDGET');
  assert.equal(diagnose('API 限流')?.code, 'PROVIDER');
  assert.equal(diagnose('课件尚未渲染完成或完成学习按钮暂不可用')?.code, 'RESOURCE_LOADING');
  assert.equal(diagnose('平台暂未确认课件操作结果')?.code, 'PLATFORM_UNCONFIRMED');
  assert.equal(diagnose('正在正常播放'), undefined);
});

test('background budget persists costs, serializes concurrent callers, and treats orphaned requests as unknown', async () => {
  const data: Record<string, unknown> = {}; const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}` }, storage: { local: {
    setAccessLevel: async () => {}, get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])),
    set: async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }, remove: async (key: string) => { delete data[key]; },
  } } } });
  const config = { version: 1 as const, endpoint: 'https://example.com/chat/completions', apiKey: 'fake', model: 'test', stream: false };
  try {
    const { beginUsage, finishUsage, readLedger, apiIdentity } = await import('../src/features/activity/usage-background');
    data[ACTIVITY_SETTINGS] = { retentionDays: 7, budget: 0.01, pricing: { identity: await apiIdentity(config), input: 1, cached: 0.1, output: 10 } };
    const calls = await Promise.allSettled([beginUsage(config), beginUsage(config)]);
    assert.equal(calls.filter(x => x.status === 'fulfilled').length, 1);
    const ticket = (calls.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof beginUsage>>>).value;
    await finishUsage(ticket, { input: 1000, output: 1000, cached: 0, reasoning: 500 });
    assert.equal((await readLedger()).cost, 0.011); await assert.rejects(beginUsage(config), /达到预算/);
    data[USAGE_KEY] = { ...emptyLedger(), pending: ['crashed-worker'] };
    assert.equal((await readLedger()).unknown, 1); await assert.rejects(beginUsage(config), /未知/);
    data[USAGE_KEY] = emptyLedger();
    const unknown = await beginUsage(config); await finishUsage(unknown);
    assert.equal((await readLedger()).unknown, 1);

    // Exercise real history storage and delayed-response tombstones with an isolated IDB.
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
    const { historyStamp, rememberResult, loadHistory, clearHistory } = await import('../src/features/activity/history-background');
    const url = 'https://www.zjooc.cn/ucenter/student/exam/fixture?paperId=1&token=secret';
    const stamp = await historyStamp(url); const q = question();
    await rememberResult(url, q, { ...answer, localProof: { context: 'private', revision: 1, libraryIds: ['lib'], entryIds: ['entry'] } }, stamp);
    const stored = JSON.stringify(data[HISTORY_KEY]); assert.ok(!stored.includes('secret')); assert.ok(!stored.includes('localProof')); assert.ok(!stored.includes('documentKey'));
    assert.equal((await loadHistory(url, [q]))[0].reusable, true);
    await clearHistory(url); await rememberResult(url, q, answer, stamp);
    assert.equal((await loadHistory(url, [q])).length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome');
  }
});
