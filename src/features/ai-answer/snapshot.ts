import type { CurrentQuestion } from './types';
import type { PreparedQuestion, QuestionSnapshot } from '../question-answer/types';

export function thinkLadderSnapshot(question: CurrentQuestion): QuestionSnapshot {
  return { key: question.key, fingerprint: question.fingerprint, number: '当前题', kind: 'completion', stem: question.stem,
    options: [], fields: [{ id: 'answer' }], children: [], images: [], supported: true };
}
export function prepareThinkLadder(question: CurrentQuestion): PreparedQuestion {
  return { question: thinkLadderSnapshot(question), images: [], suggestionTitle: question.stem, suggestionOptions: '' };
}
