import { privateStorageReady } from '../../core/background-context';
import { API_SETTINGS_KEY } from '../api-settings/types';
import { QUESTION_BANK_SETTINGS_KEY } from '../question-bank/types';
import { ANSWER_PREFERENCES_KEY, type AnswerResult, type QuestionSnapshot } from '../question-answer/types';
import { isCompleteApplicableAnswer, sameApplicableAnswer } from '../question-answer/review';
import { normalizeAnswer } from '../question-answer/normalize';
import { localBankRepository, queryStoredLibraries } from '../local-question-bank/background';
import { bankCourseContext } from '../local-question-bank/library-types';
import { activityTransaction, readActivitySettings } from './usage-background';
import { HISTORY_KEY, digest } from './types';
import { historyContext, pruneHistory, questionHistoryKey, type HistoryStore, type RestoredResult } from './history';

async function readHistory(): Promise<HistoryStore> {
  await privateStorageReady;
  const raw = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] as HistoryStore | undefined;
  const store = pruneHistory(raw ?? { epoch: 0, records: [] }, (await readActivitySettings()).retentionDays);
  if (raw && JSON.stringify(raw) !== JSON.stringify(store)) await chrome.storage.local.set({ [HISTORY_KEY]: store });
  return store;
}
async function binding(raw: string): Promise<string> {
  const config = await chrome.storage.local.get([API_SETTINGS_KEY, QUESTION_BANK_SETTINGS_KEY, ANSWER_PREFERENCES_KEY]);
  const state = await (await localBankRepository()).state(bankCourseContext(raw));
  // Configs (including credentials) stay private. Only a one-way binding is stored.
  return digest([config, state.revision, state.preferences]);
}
export async function historyStamp(raw: string): Promise<{ context: string; binding: string; epoch: number }> {
  return activityTransaction(async () => ({ context: await historyContext(raw), binding: await binding(raw), epoch: (await readHistory()).epoch }));
}
export async function rememberResult(raw: string, question: QuestionSnapshot, result: AnswerResult, stamp: Awaited<ReturnType<typeof historyStamp>>): Promise<void> {
  if (result.status !== 'answer' || !result.answer || question.images.length || question.textRecognition || !isCompleteApplicableAnswer(question, result.answer)) return;
  await activityTransaction(async () => {
    const settings = await readActivitySettings(); if (!settings.retentionDays) return;
    const store = await readHistory();
    if (store.epoch !== stamp.epoch || await binding(raw) !== stamp.binding) return;
    const key = await questionHistoryKey(question);
    // Never persist write capabilities or page/control identities.
    const safe: AnswerResult = { status: 'answer', source: result.source, text: result.text.slice(0, 32000), answer: structuredClone(result.answer) };
    store.records = store.records.filter(r => r.context !== stamp.context || r.key !== key);
    store.records.unshift({ ...stamp, key, at: Date.now(), result: safe });
    await chrome.storage.local.set({ [HISTORY_KEY]: pruneHistory(store, settings.retentionDays) });
  });
}
export async function loadHistory(raw: string, questions: QuestionSnapshot[]): Promise<RestoredResult[]> {
  return activityTransaction(async () => {
    const store = await readHistory(); const context = await historyContext(raw); const current = await binding(raw);
    const results: RestoredResult[] = [];
    for (const [index, question] of questions.entries()) {
      if (question.images.length || question.textRecognition || !question.supported) continue;
      const key = await questionHistoryKey(question);
      const record = store.records.find(r => r.context === context && r.key === key);
      if (!record?.result.answer) continue;
      const answer = normalizeAnswer(question, record.result.answer);
      if (!answer || !isCompleteApplicableAnswer(question, answer)) continue;
      const result = structuredClone(record.result); result.answer = answer;
      let reusable = record.binding === current;
      if (reusable && result.source === 'local-bank') {
        const match = await queryStoredLibraries(question, bankCourseContext(raw));
        reusable = match.status === 'matched' && Boolean(match.answer && sameApplicableAnswer(answer, match.answer));
        if (reusable) result.localProof = { revision: match.revision, libraryIds: [...new Set(match.sources.map(s => s.libraryId))], entryIds: match.sources.map(s => s.entryId), context: bankCourseContext(raw) };
      }
      results.push({ index, result, reusable, at: record.at });
    }
    return results;
  });
}
export async function clearHistory(raw?: string): Promise<void> {
  await activityTransaction(async () => {
    const store = await readHistory(); const context = raw ? await historyContext(raw) : undefined;
    await chrome.storage.local.set({ [HISTORY_KEY]: { epoch: store.epoch + 1, records: context ? store.records.filter(r => r.context !== context) : [] } });
  });
}
export async function historyCount(): Promise<number> { return (await readHistory()).records.length; }
