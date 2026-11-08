import MiniSearch from 'minisearch';
import type { ApplicableAnswer, QuestionSnapshot } from '../question-answer/types';
import type { LibraryInfo, StoredEntry } from './library-types';

export interface SimilarCandidate { entryId: string; library: string; question: QuestionSnapshot; answer: ApplicableAnswer; explanation: string; differences: string[] }
export function chineseSearchTokens(text: string): string[] {
  const parts = text.match(/[\p{Script=Han}]+|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[<>!=+*/%-]+/gu) ?? [];
  return [...new Set(parts.flatMap(part => /\p{Script=Han}/u.test(part) ? [...part].flatMap((char, i, chars) => i + 1 < chars.length ? [char + chars[i + 1]] : chars.length === 1 ? [char] : []) : [part]))];
}
const critical = (text: string) => [...new Set(text.match(/不|非|错误|正确|除外|至少|至多|大于|小于|\d+(?:\.\d+)?|[<>!=+*/%-]+/g) ?? [])].sort().join('|');
export function candidateDifferences(q: QuestionSnapshot, other: QuestionSnapshot): string[] {
  const result: string[] = [];
  if (q.stem !== other.stem) result.push('题干有差异');
  if (critical(q.stem) !== critical(other.stem)) result.push('否定条件、数字或符号不同，请重点核对');
  if (JSON.stringify(q.options.map(o => o.text).sort()) !== JSON.stringify(other.options.map(o => o.text).sort())) result.push('选项内容不同');
  if (JSON.stringify(q.options.map(o => o.text)) !== JSON.stringify(other.options.map(o => o.text)) && !result.includes('选项内容不同')) result.push('选项顺序不同');
  if (q.fields.length !== other.fields.length) result.push('填写空数不同');
  return result.length ? result : ['完整文本一致，仍需核对答案来源'];
}
export function createSimilarIndex(entries: StoredEntry[], libraries: LibraryInfo[]) {
  const names = new Map(libraries.filter(l => l.enabled).map(l => [l.id, l.name]));
  const values = entries.filter(e => names.has(e.libraryId)); const byId = new Map(values.map(e => [e.id, e]));
  const index = new MiniSearch({ fields: ['stem', 'options'], tokenize: chineseSearchTokens, processTerm: term => term,
    searchOptions: { boost: { stem: 3 }, prefix: false, fuzzy: false, combineWith: 'OR' } });
  index.addAll(values.map(e => ({ id: e.id, stem: e.record.question.stem, options: e.record.question.options.map(o => o.text).join(' ') })));
  return (question: QuestionSnapshot): SimilarCandidate[] => index.search(question.stem, { filter: result => byId.get(String(result.id))?.record.question.kind === question.kind })
    .slice(0, 40).map(hit => ({ hit, entry: byId.get(String(hit.id))! }))
    .sort((a, b) => b.hit.score * (critical(question.stem) === critical(b.entry.record.question.stem) ? 1 : .35)
      - a.hit.score * (critical(question.stem) === critical(a.entry.record.question.stem) ? 1 : .35))
    .slice(0, 5).map(({ entry }) => ({ entryId: entry.id, library: names.get(entry.libraryId)!, question: entry.record.question,
      answer: entry.record.answer, explanation: entry.explanation, differences: candidateDifferences(question, entry.record.question) }));
}
