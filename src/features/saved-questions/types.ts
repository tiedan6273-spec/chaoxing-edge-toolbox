import { isApplicableAnswer, isQuestionSnapshot } from '../question-answer/protocol';
import type { ApplicableAnswer, QuestionSnapshot } from '../question-answer/types';

export interface SavedQuestionInput {
  question: QuestionSnapshot; currentAnswer?: ApplicableAnswer; referenceAnswer?: ApplicableAnswer;
  source: string; course: string; wrong: boolean; note: string; tags: string[];
}
export interface SavedQuestion extends SavedQuestionInput {
  id: string; version: number; createdAt: string; updatedAt: string; mastered: boolean;
}
export const SAVED_LIMIT = 500;
export const SAVED_BYTES = 5 * 1024 * 1024;
export function cleanSavedInput(value: unknown): SavedQuestionInput {
  if (!value || typeof value !== 'object') throw new Error('收藏内容无效。');
  const v = value as SavedQuestionInput;
  if (!isQuestionSnapshot(v.question) || typeof v.wrong !== 'boolean'
    || typeof v.source !== 'string' || v.source.length > 200 || typeof v.course !== 'string' || v.course.length > 200
    || typeof v.note !== 'string' || v.note.length > 8000 || !Array.isArray(v.tags) || v.tags.length > 20
    || !v.tags.every(t => typeof t === 'string' && t.length <= 40)
    || (v.currentAnswer !== undefined && !isApplicableAnswer(v.currentAnswer))
    || (v.referenceAnswer !== undefined && !isApplicableAnswer(v.referenceAnswer))) throw new Error('收藏题目、答案或标签格式无效。');
  const question = structuredClone(v.question);
  // Saved notes do not retain expiring image URLs or inline image megabytes.
  if (question.images.length || question.textRecognition) { question.supported = false; question.reason = '题面含图片或未识别文字，请回原页核对。'; }
  question.images = []; delete question.markdown;
  return { question, source: v.source, course: v.course, wrong: v.wrong, note: v.note,
    tags: [...new Set(v.tags.map(t => t.trim()).filter(Boolean))],
    ...(v.currentAnswer ? { currentAnswer: structuredClone(v.currentAnswer) } : {}),
    ...(v.referenceAnswer ? { referenceAnswer: structuredClone(v.referenceAnswer) } : {}) };
}
export async function savedQuestionId(question: QuestionSnapshot, course: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    course, question.kind, question.stem, question.options, question.fields, question.children, question.program,
  ])));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
