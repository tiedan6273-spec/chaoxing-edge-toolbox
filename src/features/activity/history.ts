import type { AnswerResult, QuestionSnapshot } from '../question-answer/types';
import { digest } from './types';

export interface HistoryRecord { context: string; key: string; binding: string; at: number; result: AnswerResult }
export interface HistoryStore { epoch: number; records: HistoryRecord[] }
export interface RestoredResult { index: number; result: AnswerResult; reusable: boolean; at: number }
export interface HistoryClient {
  load(questions: QuestionSnapshot[]): Promise<RestoredResult[]>;
  clear(): Promise<void>;
}
/** Exact content, including option identifiers and order; no relaxed or numeric-prefix matching. */
export const questionHistoryKey = (q: QuestionSnapshot): Promise<string> => digest([
  q.kind, q.stem, q.options, q.fields, q.children, q.images, q.program ?? null, q.textRecognition ?? null,
]);
export async function historyContext(raw: string): Promise<string> {
  const url = new URL(raw);
  const route = url.hash.startsWith('#/') ? url.hash.slice(1) : url.pathname + url.search;
  const parts = route.split('?'); const params = new URLSearchParams(parts[1] ?? '');
  const ids = ['courseId', 'courseid', 'clazzid', 'chapterId', 'examId', 'paperId', 'testId', 'id', 'workId', 'workid', 'examid', 'testid', 'paperid'];
  return digest([url.origin, parts[0], ids.map(key => [key, params.get(key) ?? url.searchParams.get(key) ?? ''])]);
}
export function pruneHistory(store: HistoryStore, days: number, now = Date.now()): HistoryStore {
  const candidates = days ? store.records.filter(r => r.at > now - days * 86400000 && r.at <= now)
    .sort((a, b) => b.at - a.at).slice(0, 600) : [];
  const records: HistoryRecord[] = []; const encoder = new TextEncoder(); let bytes = 2;
  // Linear accounting includes array brackets and separators; never repeatedly serialize the full store.
  for (const record of candidates) {
    const size = encoder.encode(JSON.stringify(record)).length + (records.length ? 1 : 0);
    if (bytes + size > 2_000_000) break;
    bytes += size; records.push(record);
  }
  return { epoch: store.epoch, records };
}
