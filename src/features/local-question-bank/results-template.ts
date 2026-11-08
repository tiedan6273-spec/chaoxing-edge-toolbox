import { canExportQuestion, sanitizeBankEntry } from '../answer-exchange/protocol';
import { isCompleteApplicableAnswer } from '../question-answer/review';
import type { ResultsExportFile } from '../question-answer/export';
import type { QuestionAnswerState } from '../question-answer/types';
import type { DraftEntry } from './library-types';
import { serializeBankTemplate } from './template';

export function createResultsTemplateFile(state: QuestionAnswerState, origin: 'result' | 'page', title: string): ResultsExportFile {
  if (state.previewStale) throw new Error('页面已经变化，请重新读取题目后再导出题库模板。');
  const entries: DraftEntry[] = [];
  for (const row of state.rows) {
    const question = row.target.question; const answer = origin === 'result' ? row.resultAnswer : row.currentAnswer;
    if (!['single', 'multiple', 'judgement', 'completion'].includes(question.kind) || !canExportQuestion(question)
      || !answer || !isCompleteApplicableAnswer(question, answer)) continue;
    entries.push({ record: sanitizeBankEntry({ question, answer }), number: String(entries.length + 1),
      kindLabel: question.kind === 'completion' && question.fields.length === 1 ? '简答' : '', explanation: '', position: '页面结果导出，待核对' });
  }
  const content = serializeBankTemplate(entries, title);
  // eslint-disable-next-line no-control-regex
  return { name: `题库模板-${title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 60) || '题目'}.txt`,
    mime: 'text/plain;charset=utf-8', content, count: entries.length };
}
