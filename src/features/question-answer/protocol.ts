import type { AnswerPageCommand, AnswerPageResult, ApplicableAnswer, PreparedQuestion, QuestionPageSnapshot, QuestionSnapshot } from './types';
import { QUESTION_MARKDOWN_LIMIT } from './types';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length <= max;
const list = (value: unknown, check: (item: unknown) => boolean, max = 200): boolean => Array.isArray(value) && value.length <= max && value.every(check);
const strings = (value: unknown, max = 32000) => list(value, item => text(item, max));
const option = (value: unknown) => object(value) && text(value.id) && text(value.label) && text(value.text, 16000);
const imageData = (value: unknown): value is string => text(value, 4_000_000) && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value);
const program = (value: unknown): boolean => {
  if (!object(value) || !Object.keys(value).every(key => key === 'language')) return false;
  const language = value.language;
  return typeof language === 'string' && language.length <= 100 && Boolean(language.trim());
};

export function isQuestionTextRecognition(value: unknown): boolean {
  if (!object(value) || !Object.keys(value).every(key => ['status', 'unresolvedCount', 'unresolved'].includes(key))
      || !['pending', 'partial', 'unavailable'].includes(String(value.status))
      || !Number.isSafeInteger(value.unresolvedCount) || (value.unresolvedCount as number) < 1 || (value.unresolvedCount as number) > 128000) return false;
  let count = 0;
  let size = 0;
  return list(value.unresolved, item => {
    if (!object(item) || !Object.keys(item).every(key => ['raw', 'count'].includes(key)) || !text(item.raw, 32000)
        || !item.raw.length || !Number.isSafeInteger(item.count) || item.count !== Array.from(item.raw).length) return false;
    count += item.count as number; size += item.raw.length;
    return size <= 128000;
  }, 1024) && count === value.unresolvedCount;
}

function imageReferences(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 16) return false;
  let size = 0;
  return value.every(item => {
    if (imageData(item)) { size += item.length; return size <= 12_000_000; }
    return text(item, 4096) && /^https:\/\//.test(item);
  });
}

export function isQuestionSnapshot(value: unknown): value is QuestionSnapshot {
  return object(value) && text(value.key) && text(value.fingerprint) && text(value.number)
    && ['single', 'multiple', 'judgement', 'completion', 'line', 'fill', 'reader', 'program', 'unsupported'].includes(String(value.kind))
    && text(value.stem, 32000) && typeof value.supported === 'boolean'
    && (value.markdown === undefined || text(value.markdown, QUESTION_MARKDOWN_LIMIT))
    && (value.reviewData === undefined || object(value.reviewData) && isApplicableAnswer(value.reviewData.answer)
      && text(value.reviewData.explanation, 32000) && (value.reviewData.score === undefined || text(value.reviewData.score, 100))
      && (value.reviewData.maxScore === undefined || text(value.reviewData.maxScore, 100)))
    && (value.program === undefined || program(value.program))
    && (value.reason === undefined || text(value.reason, 1000)) && list(value.options, option)
    && (value.textRecognition === undefined || isQuestionTextRecognition(value.textRecognition))
    && list(value.fields, field => object(field) && text(field.id) && (field.options === undefined || list(field.options, option)))
    && list(value.children, child => object(child) && text(child.id) && text(child.stem, 16000) && list(child.options, option))
    && imageReferences(value.images);
}

export function isApplicableAnswer(value: unknown): value is ApplicableAnswer {
  if (!object(value)) return false;
  return Object.keys(value).every(key => ['choices', 'texts', 'matches', 'children', 'code'].includes(key))
    && (value.choices === undefined || strings(value.choices, 1000))
    && (value.texts === undefined || strings(value.texts))
    && (value.matches === undefined || strings(value.matches, 1000))
    && (value.code === undefined || text(value.code, 32000))
    && (value.children === undefined || list(value.children, child => object(child) && text(child.id) && strings(child.choices, 1000)));
}

export function isPreparedQuestion(value: unknown): value is PreparedQuestion {
  if (!object(value) || !isQuestionSnapshot(value.question) || value.question.reviewData !== undefined || !text(value.suggestionTitle, 32000) || !text(value.suggestionOptions, 64000)) return false;
  if (!Array.isArray(value.images) || value.images.length > 16) return false;
  let size = 0;
  return value.images.every(image => {
    if (!imageData(image)) return false;
    size += image.length;
    return size <= 12_000_000;
  });
}

export function isQuestionPageSnapshot(value: unknown): value is QuestionPageSnapshot {
  return object(value) && text(value.documentKey) && text(value.scopeKey)
    && ['chapter-test', 'homework', 'exam', 'unsupported'].includes(String(value.scene))
    && list(value.questions, isQuestionSnapshot, 300) && typeof value.complete === 'boolean' && typeof value.allLoaded === 'boolean'
    && typeof value.canSave === 'boolean' && typeof value.canSubmit === 'boolean';
}

export function isAnswerPageCommand(value: unknown): value is AnswerPageCommand {
  if (!object(value)) return false;
  if (value.action === 'inspect' || value.action === 'cancel') return true;
  if (!text(value.documentKey) || !text(value.scopeKey)) return false;
  if (value.action === 'flow') return ['inspect', 'save', 'next'].includes(String(value.operation))
    && (value.attemptKey === undefined || text(value.attemptKey)) && (value.pageKey === undefined || text(value.pageKey))
    && (value.expected === undefined || list(value.expected, item => object(item) && text(item.key) && text(item.fingerprint) && text(item.version, 200000), 300));
  if (value.action === 'finish') return ['save', 'submit'].includes(String(value.policy))
    && list(value.expected, item => object(item) && text(item.key) && text(item.fingerprint) && text(item.version, 200000), 300);
  if (!text(value.key) || !text(value.fingerprint)) return false;
  if (value.action === 'read' || value.action === 'images') return true;
  return value.action === 'write' && text(value.expectedVersion, 200000) && typeof value.replace === 'boolean' && isApplicableAnswer(value.answer);
}

export function isAnswerPageResult(value: unknown): value is AnswerPageResult {
  return object(value) && typeof value.ok === 'boolean' && (value.error === undefined || text(value.error, 2000))
    && (value.flow === undefined || object(value.flow) && text(value.flow.attemptKey) && text(value.flow.pageKey)
      && Number.isSafeInteger(value.flow.page) && Number(value.flow.page) >= 0 && Number(value.flow.page) <= 100000
      && (value.flow.total === undefined || Number.isSafeInteger(value.flow.total) && Number(value.flow.total) > 0 && Number(value.flow.total) <= 100000)
      && typeof value.flow.canNext === 'boolean' && typeof value.flow.terminal === 'boolean' && typeof value.flow.canSave === 'boolean' && text(value.flow.reason, 1000))
    && (value.warning === undefined || text(value.warning, 1000))
    && (value.snapshot === undefined || isQuestionPageSnapshot(value.snapshot))
    && (value.prepared === undefined || isPreparedQuestion(value.prepared))
    && (value.outcome === undefined || value.outcome === 'saved' || value.outcome === 'submitted')
    && (value.control === undefined || (object(value.control) && typeof value.control.ready === 'boolean'
      && typeof value.control.hasContent === 'boolean' && typeof value.control.complete === 'boolean'
      && text(value.control.version, 200000) && isApplicableAnswer(value.control.answer)));
}
