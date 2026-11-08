import { getDocumentPlatform } from '../../../shared/sites';
import { inspectQuestionPage as inspectChaoxing } from './chaoxing';
import { inspectZjoocQuestionPage } from './zjooc';

export { chapterAction, normalizeText, readQuestionControl, readSavedProgramCode, visible } from './chaoxing';
export type { PageInspection, QuestionEntry } from './chaoxing';

export function inspectQuestionPage(win: Window) {
  return getDocumentPlatform(win)?.id === 'zjooc' ? inspectZjoocQuestionPage(win) : inspectChaoxing(win);
}
