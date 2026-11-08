import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createQuestionAnswerController } from '../src/features/question-answer/controller';
import { answerDifference, createReviewQuestion, parseQuestionReview, sameApplicableAnswer, type QuestionReviewRequest, type QuestionReviewResult } from '../src/features/question-answer/review';
import { API_SETTINGS_KEY, normalizeApiSettings, rankedProfiles, validateApiSettings, type ApiConfig, type ApiSettings } from '../src/features/api-settings/types';
import { createConfigBackupService } from '../src/features/config-backup/service';
import { BACKUP_FORMAT, backupOrigins, parseConfigBackup } from '../src/features/config-backup/format';
import { ACTIVITY_SETTINGS, USAGE_KEY, emptyLedger } from '../src/features/activity/types';
import { QUESTION_BANK_ORIGIN, QUESTION_BANK_SETTINGS_KEY } from '../src/features/question-bank/types';
import { usageRingState } from '../src/features/activity/ring';
import { API_PRESETS, presetApiConfig } from '../src/features/api-settings/presets';
import { buildQuestionAnswerMessages, parseQuestionAiAnswer } from '../src/features/ai-answer/question-provider';
import { requestChatCompletion } from '../src/features/api-settings/model-client';
import type { AnswerRuntime } from '../src/features/question-answer/client';
import type { AnswerRow, AnswerSourcesStatus, ApplicableAnswer, QuestionSnapshot } from '../src/features/question-answer/types';

const config: ApiConfig = { version: 1, endpoint: 'https://example.com/v1/chat/completions', apiKey: 'fake-only', model: 'text', stream: false };
const q = (): QuestionSnapshot => ({ key: 'q1', fingerprint: 'fp1', number: '1', kind: 'single', stem: '选甲', options: [{ id: 'a', label: 'A', text: '甲' }, { id: 'b', label: 'B', text: '乙' }], fields: [], children: [], images: [], supported: true });
const sources: AnswerSourcesStatus = { selection: 'ai', bank: { configured: false, authorized: false }, ai: { enabled: true, authorized: true, configured: true, supportsImages: true } };
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check: () => boolean) { for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); } throw new Error('timed out'); }
function harness() {
  const question = q(); let answer: ApplicableAnswer = { choices: ['b'] }; let invalidation: (() => void) | undefined;
  const calls = { reviews: 0, writes: 0 };
  let generateReview = async (request: QuestionReviewRequest): Promise<QuestionReviewResult> => ({ batchId: request.batchId, items: [{ questionId: 'q-1', status: 'suspect', suggestedAnswer: { choices: ['a'] }, reason: '选甲' }] });
  const runtime: AnswerRuntime = {
    scan: async () => [{ frameId: 0, snapshot: { documentKey: 'doc', scopeKey: 'paper', scene: 'exam', allLoaded: true, complete: false, canSave: false, canSubmit: false, questions: [structuredClone(question)] } }],
    page: async (_, command) => { if (command.action !== 'read') calls.writes++; return { ok: true, control: { ready: true, version: JSON.stringify(answer), answer: structuredClone(answer), hasContent: true, complete: Boolean(answer.choices?.length) } }; },
    cancel() {}, subscribeInvalidation(fn) { invalidation = fn; return () => {}; },
  };
  const controller = createQuestionAnswerController({ runtime, isEnabled: () => true, getSources: async () => structuredClone(sources), saveSource: async () => {},
    generate: async () => { throw new Error('unexpected generation'); }, review: async request => { calls.reviews++; return generateReview(request); } });
  return { controller, calls, question, setAnswer(a: ApplicableAnswer) { answer = a; }, invalidate() { invalidation?.(); }, setReview(fn: typeof generateReview) { generateReview = fn; },
    async done() { await until(() => !controller.getState().running && ['complete', 'error', 'paused'].includes(controller.getState().phase)); } };
}

test('one review is single-flight, repeated unchanged reviews reuse results, explicit redo and changed data request once', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 10; i++) h.controller.reviewAnswers!();
    await h.done(); assert.equal(h.calls.reviews, 1); assert.equal(h.controller.getState().rows[0].review?.status, 'suspect');
    h.controller.reviewAnswers!(); await h.done(); assert.equal(h.calls.reviews, 1); assert.match(h.controller.getState().reviewProgress!, /无新增/);
    h.controller.reviewAnswers!(true); await h.done(); assert.equal(h.calls.reviews, 2);
    h.setAnswer({ choices: ['a'] }); h.controller.preview!(); await until(() => !h.controller.getState().previewing);
    assert.equal(h.controller.getState().reviewAvailable, false);
    h.controller.reviewAnswers!(); await h.done(); assert.equal(h.calls.reviews, 3);
    h.controller.settingsChanged!(); h.controller.reviewAnswers!(); await h.done(); assert.equal(h.calls.reviews, 4);
    assert.equal(h.calls.writes, 0);
  } finally { h.controller.dispose(); }
});

test('edits during a review discard late findings; a stopped review cannot publish or start another request', async () => {
  const h = harness(); let release: (() => void) | undefined;
  h.setReview(async request => { await new Promise<void>(r => { release = r; }); return { batchId: request.batchId, items: [{ questionId: 'q-1', status: 'suspect', suggestedAnswer: { choices: ['a'] }, reason: '选甲' }] }; });
  try {
    h.controller.reviewAnswers!(); await until(() => Boolean(release)); h.setAnswer({ choices: ['a'] }); release!(); await h.done();
    assert.match(h.controller.getState().reviewError!, /答案已变化/); assert.equal(h.controller.getState().rows[0].review, undefined);
    release = undefined; h.controller.reviewAnswers!(); await until(() => Boolean(release)); h.controller.stop(); release!(); await h.done();
    assert.equal(h.calls.reviews, 2); assert.equal(h.calls.writes, 0); assert.equal(h.controller.getState().rows[0].review, undefined);
  } finally { h.controller.dispose(); }
});

test('paper invalidation and incomplete answers cannot reuse or send a review', async () => {
  const h = harness();
  try {
    h.controller.reviewAnswers!(); await h.done(); h.invalidate(); h.question.fingerprint = 'changed';
    h.controller.reviewAnswers!(); await h.done(); assert.equal(h.calls.reviews, 2);
    h.setAnswer({}); h.controller.reviewAnswers!(); await h.done(); assert.equal(h.calls.reviews, 2); assert.match(h.controller.getState().reviewError!, /未完整作答/);
  } finally { h.controller.dispose(); }
});

test('review compares independent answers locally even when model status is wrong, with unordered multiple choices', () => {
  const request: QuestionReviewRequest = { batchId: 'batch', items: [{ questionId: 'q-1', question: createReviewQuestion(q()), currentAnswer: { choices: ['b'] }, images: [] }] };
  const parse = (item: object) => parseQuestionReview(request, JSON.stringify({ version: 1, mode: 'review', batchId: 'batch', items: [{ questionId: 'q-1', ...item }] }));
  assert.equal(parse({ status: 'pass', suggestedAnswer: { choices: ['a'] } }).items[0].status, 'suspect');
  assert.equal(parse({ status: 'suspect', suggestedAnswer: { choices: ['b'] }, reason: 'same' }).items[0].status, 'pass');
  assert.equal(parse({ status: 'pass' }).items[0].status, 'pass'); // legacy model response remains readable
  assert.throws(() => parse({ status: 'pass', suggestedAnswer: { choices: ['unknown'] } }), /不完整/);
  assert.equal(sameApplicableAnswer({ choices: ['a', 'b'] }, { choices: ['b', 'a'] }), true);
  assert.equal(sameApplicableAnswer({ texts: ['one', 'two'] }, { texts: ['two', 'one'] }), false);
});

test('ordinary AI results mark complete mismatches, clear after matching edits and leave empty/partial answers unmarked', () => {
  const row: AnswerRow = { id: 'row', target: { frameId: 0, documentKey: 'doc', scopeKey: 'scope', question: q() }, phase: 'searched', message: '', text: '', source: 'ai', currentAnswer: { choices: ['b'] }, resultAnswer: { choices: ['a'] } };
  assert.equal(answerDifference(row)?.status, 'suspect');
  row.currentAnswer = { choices: ['a'] }; assert.equal(answerDifference(row), undefined);
  row.currentAnswer = {}; assert.equal(answerDifference(row), undefined);
  row.currentAnswer = { choices: ['b'] }; row.source = 'local-bank'; assert.equal(answerDifference(row), undefined);
  row.source = 'ai'; row.target.question.kind = 'multiple'; row.currentAnswer = { choices: ['b', 'a'] }; row.resultAnswer = { choices: ['a', 'b'] }; assert.equal(answerDifference(row), undefined);
});

test('legacy model migration preserves credentials, disabled models and priorities determine stable selection', () => {
  const settings = normalizeApiSettings(config); assert.deepEqual(settings.profiles[0].config, { ...config, supportsImages: false });
  settings.profiles.push({ id: 'other', name: '图像', priority: 1, enabled: true, config: { ...config, model: 'image', supportsImages: true } });
  assert.deepEqual(rankedProfiles(settings).map(p => p.id), ['legacy', 'other']);
  assert.deepEqual(rankedProfiles(settings, true).map(p => p.id), ['other']);
  settings.profiles[0].enabled = false; assert.equal(rankedProfiles(settings)[0].id, 'other');
  const invalid = structuredClone(settings); invalid.profiles[1].id = 'legacy'; assert.throws(() => validateApiSettings(invalid));
  invalid.profiles[1].id = 'other'; invalid.profiles[1].priority = 0; assert.throws(() => validateApiSettings(invalid));
  assert.throws(() => normalizeApiSettings({ version: 2, profiles: 'corrupt' }));
});

test('multi-model backups round-trip priorities and disabled entries; old single-model restore remains supported', async () => {
  const settings = normalizeApiSettings(config); settings.profiles.push({ id: 'second', name: '第二模型', priority: 5, enabled: false, config: { ...config, endpoint: 'https://other.example/chat/completions', model: 'other' } });
  let data: Record<string, unknown> = { [API_SETTINGS_KEY]: settings }; const released: string[] = [];
  const service = createConfigBackupService({ read: async () => structuredClone(data), write: async values => { data = { ...data, ...structuredClone(values) }; }, authorized: async () => true, release: async origin => { released.push(origin); } });
  const backup = await service.export(); assert.equal(backup.version, 2);
  assert.deepEqual(parseConfigBackup(JSON.stringify(backup)).apiProfiles, normalizeApiSettings(settings));
  assert.equal(backupOrigins(backup).length, 2);
  await service.restore({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), api: config });
  assert.equal(normalizeApiSettings(data[API_SETTINGS_KEY]).profiles.length, 1); assert.deepEqual(released, ['https://other.example/*']);
  await service.restore(backup); assert.equal(normalizeApiSettings(data[API_SETTINGS_KEY]).profiles[1].enabled, false);
});

test('background chooses authorized capable priority, preserves shared origins, and meters models at their own prices', async () => {
  const data: Record<string, unknown> = { [API_SETTINGS_KEY]: config }; const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const grants = new Set(['https://example.com/*', QUESTION_BANK_ORIGIN]); const removed: string[] = [];
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}` }, permissions: {
    contains: async ({ origins }: { origins: string[] }) => origins.every(o => grants.has(o)), remove: async ({ origins }: { origins: string[] }) => { origins.forEach(o => { removed.push(o); grants.delete(o); }); },
  }, storage: { local: { setAccessLevel: async () => {}, get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])), set: async (v: Record<string, unknown>) => { Object.assign(data, structuredClone(v)); } } } } });
  try {
    const api = await import('../src/features/api-settings/background');
    const usage = await import('../src/features/activity/usage-background');
    const activity = await import('../src/features/activity/background');
    const settings = normalizeApiSettings(config); settings.profiles[0].priority = 5;
    settings.profiles.push({ id: 'vision', name: '视觉', priority: 2, enabled: true, config: { ...config, model: 'vision', endpoint: QUESTION_BANK_ORIGIN.replace('*', 'v1/chat/completions'), supportsImages: true } });
    await api.apiSettingsRoutes['toolbox:api:profiles-save'].handle({ settings }, {});
    assert.equal((await api.requireApiConfig()).model, 'vision'); assert.equal((await api.requireApiConfig(true)).model, 'vision');
    grants.delete(QUESTION_BANK_ORIGIN); assert.equal((await api.requireApiConfig()).model, 'text'); await assert.rejects(api.requireApiConfig(true));
    grants.add(QUESTION_BANK_ORIGIN);
    const identity = await usage.apiIdentity(config); const visionIdentity = await usage.apiIdentity(settings.profiles[1].config);
    data[ACTIVITY_SETTINGS] = { retentionDays: 7, budget: 1, pricing: { identity, input: 1, cached: 0.1, output: 2 } };
    const setPrice = activity.activityRoutes['toolbox:activity:save'].handle;
    await setPrice({ identity: visionIdentity, settings: { retentionDays: 7, budget: 1, pricing: { input: 10, cached: 1, output: 20 } } }, {});
    const first = await usage.beginUsage(config); await usage.finishUsage(first, { input: 1000, output: 1000, cached: 0, reasoning: 0 });
    const second = await usage.beginUsage(settings.profiles[1].config); await usage.finishUsage(second, { input: 1000, output: 1000, cached: 0, reasoning: 0 });
    assert.ok(Math.abs((await usage.readLedger()).cost - 0.033) < 1e-9);
    settings.profiles[0].priority = 1; await api.apiSettingsRoutes['toolbox:api:profiles-save'].handle({ settings }, {});
    assert.equal((await usage.readLedger()).requests, 2); assert.equal((await api.requireApiConfig()).model, 'text');
    data[QUESTION_BANK_SETTINGS_KEY] = { version: 1, token: 'fake-bank' };
    settings.profiles = settings.profiles.slice(0, 1); await api.apiSettingsRoutes['toolbox:api:profiles-save'].handle({ settings }, {});
    assert.ok(!removed.includes(QUESTION_BANK_ORIGIN)); assert.ok(grants.has(QUESTION_BANK_ORIGIN));
    await assert.rejects(setPrice({ identity: visionIdentity, settings: { retentionDays: 7, budget: 1 } }, {}), /变化/);
    data[USAGE_KEY] = emptyLedger(); await assert.rejects(usage.beginUsage({ ...config, model: 'unpriced' }), /保存价格/);
    assert.ok(!JSON.stringify(await api.readApiStatus()).includes('fake-only'));
  } finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); }
});

test('model list saves ordered toggles, rolls back cancelled edits and isolates preset keys and explicit tests', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/' });
  const saved: ApiSettings = normalizeApiSettings(config); saved.profiles.push({ id: 'second', name: '第二', priority: 2, enabled: true, config: { ...config, model: 'second' } });
  const previous = new Map(['window', 'document', 'CustomEvent', 'chrome'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const tests: string[] = []; let written: ApiSettings | undefined;
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', { value: function(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'close', { value: function(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  const rpc = async (message: { type: string; profileId?: string; settings?: ApiSettings }) => {
    if (message.type === 'toolbox:api:profiles') return structuredClone(saved);
    if (message.type === 'toolbox:api:profiles-save') { written = structuredClone(message.settings!); return; }
    if (message.type === 'toolbox:api:test') { tests.push(message.profileId!); return { message: '连接成功', latencyMs: 1 }; }
  };
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, chrome: { runtime: { sendMessage: async (m: Parameters<typeof rpc>[0]) => ({ ok: true, value: await rpc(m) }) }, permissions: { request: async () => true } } })) Object.defineProperty(globalThis, k, { configurable: true, value: v });
  let dispose: (() => void) | undefined;
  try {
    const { mountApiSettings } = await import('../src/features/api-settings/ui'); const root = document.getElementById('root')!; dispose = mountApiSettings(root);
    await until(() => root.querySelectorAll('.model-row').length === 2);
    const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click();
    click('[data-profile=legacy] .model-name');
    const model = root.querySelector<HTMLInputElement>('#api-model')!; model.value = 'cancelled'; model.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click('.cancel-model'); assert.equal(root.dataset.dirty, 'false'); assert.equal(written, undefined);
    click('[data-profile=legacy] .model-name'); assert.equal(model.value, config.model);
    model.value = 'edited'; model.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await until(() => Boolean(written));
    await until(() => !root.querySelector<HTMLDialogElement>('dialog')!.open && root.getAttribute('aria-busy') === 'false');
    click('[data-profile=second] [aria-label^="测试"]'); click('[data-profile=second] [aria-label^="测试"]'); await until(() => tests.length === 1);
    assert.deepEqual(tests, ['second']); assert.equal(written!.profiles[0].config.model, 'edited');
    await until(() => root.getAttribute('aria-busy') === 'false');
    click('[data-profile=second] [data-move="-1"]');
    const toggle = root.querySelector<HTMLInputElement>('[data-profile=second] input')!; toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change'));
    click('[data-profile=legacy] [aria-label^="移除"]'); assert.equal(root.querySelectorAll('.model-row').length,1); click('.model-undo');
    written = undefined; click('.save-api'); await until(() => !!written && root.getAttribute('aria-busy') === 'false');
    assert.deepEqual(written!.profiles.map(p => [p.id,p.priority,p.enabled]), [['second',1,false],['legacy',2,true]]);
    click('[data-preset="deepseek-1017"]');
    assert.equal(model.value, 'deepseek-v4.1-flash-1017');
    assert.equal(root.querySelector<HTMLInputElement>('#api-key')!.value, '');
    assert.equal(root.querySelectorAll('.model-row').length, 3); click('.cancel-model');
    assert.equal(root.querySelectorAll('.model-row').length, 2); click('[data-profile=legacy] .model-name');
    assert.equal(root.querySelector<HTMLInputElement>('#api-key')!.value, 'fake-only');
    const preset = root.querySelector<HTMLSelectElement>('#api-preset')!; preset.value = 'mimo-flash'; click('.apply-preset');
    assert.equal(root.querySelector<HTMLInputElement>('#api-key')!.value, ''); click('.cancel-model');
    click('[data-profile=legacy] .model-name'); assert.equal(root.querySelector<HTMLInputElement>('#api-key')!.value, 'fake-only'); click('.cancel-model');
    assert.equal(root.querySelector<HTMLInputElement>('#api-key')!.value, ''); assert.ok(!root.querySelector('.model-list')!.textContent!.includes('fake-only'));
  } finally { dispose?.(); dom.window.close(); for (const [k, d] of previous) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k); } }
});

test('budget ring shows known spending, clamps only its arc, and distinguishes unset/unknown/pending values', () => {
  const status = { settings: { retentionDays: 7 as const, budget: 1 }, ledger: { ...emptyLedger(), cost: 0.5 }, model: 'test', identity: '', priced: true, historyCount: 0 };
  assert.equal(usageRingState(status).label, '50%'); assert.equal(usageRingState(status).ratio, 0.5);
  status.ledger.cost = 1.25; assert.equal(usageRingState(status).label, '125%'); assert.equal(usageRingState(status).ratio, 1); assert.equal(usageRingState(status).state, 'exceeded');
  status.ledger.unknown = 1; assert.match(usageRingState(status).label, /^≥/); assert.match(usageRingState(status).detail, /待核对/);
  status.settings.budget = 0; assert.equal(usageRingState(status).label, '未设预算');
  status.ledger.pending = ['in-flight']; assert.match(usageRingState(status).detail, /进行中/);
});

test('presets create empty-key configs and requested 1017 model ID reaches the real request body unchanged', async () => {
  for (const preset of API_PRESETS) { const value = presetApiConfig(preset.id); assert.equal(value.apiKey, ''); assert.ok(value.endpoint.endsWith('/chat/completions')); }
  assert.equal(presetApiConfig('mimo-flash').model, 'mimo-v2.6-flash');
  assert.notEqual(new URL(presetApiConfig('mimo-plan').endpoint).host, new URL(presetApiConfig('mimo-flash').endpoint).host);
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_, init) => { calls++; const body = JSON.parse(init!.body as string); assert.equal(body.model, 'deepseek-v4.1-flash-1017'); return new Response(JSON.stringify({ choices: [{ message: { content: '连接成功' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }); };
  try { await requestChatCompletion({ ...presetApiConfig('deepseek-1017'), apiKey: 'fake-only' }, [{ role: 'user', content: 'test' }], new AbortController().signal); assert.equal(calls, 1); }
  finally { globalThis.fetch = previous; }
});

test('text generation requests one concise final answer while retaining explicit length, formulas and code', () => {
  const question = q(); question.kind = 'completion'; question.fields = [{ id: 'field-1' }]; question.stem = '说明约束条件，至少 300 字。';
  const prepared = { question, images: [], suggestionTitle: question.stem, suggestionOptions: '' };
  const messages = buildQuestionAnswerMessages(prepared, config);
  assert.match(messages[0].content as string, /精简后的最终答案/); assert.match(messages[0].content as string, /字数.*优先于精简/);
  assert.match(messages[1].content as string, /至少 300 字/);
  const text = '不得超过 5 V；x = a + b。\n1. 保留单位。\n2. 保留结论。';
  assert.deepEqual(parseQuestionAiAnswer(prepared, JSON.stringify({ texts: [text] })).answer, { texts: [text] });
  question.kind = 'program'; question.fields = []; question.program = { language: 'C' };
  assert.ok(!(buildQuestionAnswerMessages(prepared, config)[0].content as string).includes('精简后的最终答案'));
});
