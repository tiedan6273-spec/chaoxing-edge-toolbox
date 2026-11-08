import type { BankEntry } from '../answer-exchange/types';
import { normalizeAnswer } from '../question-answer/normalize';
import type { ApplicableAnswer, QuestionOption, QuestionSnapshot } from '../question-answer/types';
import type { LocalBankMatch } from './types';
import { judgementMeaning } from './semantic';

// NFC preserves formula symbols, superscripts, case, punctuation and negation.
const normalized = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim();
const positionReference = /以上|上述|下述|(?:前|后)(?:[一二三四五六七八九十两\d]+)?(?:项|者|个)|第[一二三四五六七八九十两\d]+(?:项|个|种|条)|(?:选项|答案)\s*[A-ZＡ-Ｚ]|[A-ZＡ-Ｚ]\s*(?:和|与|及|、|\/|或|&|\+|，|,)\s*[A-ZＡ-Ｚ]|\b[A-Z]\s+(?:and|or|nor)\s+[A-Z]\b|(?:all|both|none)\s+of\s+(?:the\s+)?(?:above|below)|(?:option|choices?)\s+[a-z]\b/i;

function usable(question: QuestionSnapshot): boolean {
  return question.supported && question.kind !== 'unsupported' && !question.textRecognition
    && question.images.length === 0 && Boolean(question.stem.trim());
}

function optionShape(options: QuestionOption[], reorder: boolean, includeLabels: boolean): Array<string | [string, string]> | undefined {
  const texts = options.map(option => normalized(option.text));
  if (texts.some(text => !text) || new Set(texts).size !== texts.length) return;
  if (includeLabels) {
    const labels = options.map(option => normalized(option.label));
    if (labels.some(label => !label) || new Set(labels).size !== labels.length) return;
    return texts.map((text, index): [string, string] => [labels[index], text]);
  }
  return reorder ? texts.sort() : texts;
}

/** Content identity is independent of page IDs; compound item order remains significant. */
export function localQuestionContentKey(question: QuestionSnapshot): string | undefined {
  if (!usable(question)) return;
  const stem = normalized(question.stem);
  const positionDependent = positionReference.test([stem, ...question.options.map(option => option.text),
    ...question.fields.flatMap(field => field.options?.map(option => option.text) ?? []),
    ...question.children.flatMap(child => [child.stem, ...child.options.map(option => option.text)])].join('\n'));
  const canonicalOptions = question.kind === 'judgement' ? question.options.map(option => ({ ...option,
    text: judgementMeaning(option.text) === true ? '正确' : judgementMeaning(option.text) === false ? '错误' : option.text })) : question.options;
  const options = optionShape(canonicalOptions, !positionDependent, positionDependent);
  if (!options) return;
  const fields = question.fields.map(field => field.options?.length ? optionShape(field.options, false, positionDependent) : null);
  const children = question.children.map(child => ({ stem: normalized(child.stem), options: optionShape(child.options, false, positionDependent) }));
  if (fields.some(field => field === undefined) || children.some(child => !child.options)) return;
  return JSON.stringify([question.kind, stem, options, fields, children]);
}

function optionIds(source: QuestionOption[], target: QuestionOption[], ids: string[]): string[] | undefined {
  const mapped = ids.map(id => {
    const originals = source.filter(option => option.id === id);
    if (originals.length !== 1) return;
    const text = normalized(originals[0].text);
    const matches = target.filter(option => normalized(option.text) === text);
    return matches.length === 1 ? matches[0].id : undefined;
  });
  return mapped.every((id): id is string => typeof id === 'string') ? mapped : undefined;
}

function remapAnswer(source: QuestionSnapshot, target: QuestionSnapshot, raw: ApplicableAnswer): ApplicableAnswer | undefined {
  const answer = normalizeAnswer(source, raw);
  if (!answer) return;
  let mapped: ApplicableAnswer | undefined;
  if (answer.choices) {
    const choices = source.kind === 'judgement' ? answer.choices.map(id => {
      const option = source.options.find(item => item.id === id); const meaning = option && judgementMeaning(option.text);
      const candidates = meaning === undefined ? [] : target.options.filter(item => judgementMeaning(item.text) === meaning);
      return candidates.length === 1 ? candidates[0].id : undefined;
    }) : optionIds(source.options, target.options, answer.choices);
    if (choices?.every((id): id is string => typeof id === 'string')) mapped = { choices };
  } else if (answer.texts) mapped = { texts: answer.texts };
  else if (answer.code !== undefined) mapped = { code: answer.code };
  else if (answer.matches) {
    const matches = answer.matches.map((id, index) => optionIds(source.fields[index].options ?? [], target.fields[index].options ?? [], [id])?.[0]);
    if (matches.every((id): id is string => typeof id === 'string')) mapped = { matches };
  } else if (answer.children) {
    const children = source.children.map((child, index) => {
      const original = answer.children!.find(value => value.id === child.id);
      const choices = original && optionIds(child.options, target.children[index].options, original.choices);
      return choices ? { id: target.children[index].id, choices } : undefined;
    });
    if (children.every((child): child is { id: string; choices: string[] } => child !== undefined)) mapped = { children };
  }
  return mapped && normalizeAnswer(target, mapped);
}

function semanticAnswer(question: QuestionSnapshot, raw: ApplicableAnswer): unknown {
  const answer = normalizeAnswer(question, raw);
  if (!answer) return;
  const texts = (options: QuestionOption[], ids: string[]) => ids.map(id => normalized(options.find(option => option.id === id)!.text)).sort();
  if (answer.choices) return { choices: texts(question.options, answer.choices) };
  if (answer.texts) return { texts: answer.texts };
  if (answer.code !== undefined) return { code: answer.code };
  if (answer.matches) return { matches: answer.matches.map((id, index) => texts(question.fields[index].options ?? [], [id])[0]) };
  if (answer.children) return { children: question.children.map(child => texts(child.options, answer.children!.find(value => value.id === child.id)!.choices)) };
}

/** Equivalent records deduplicate; different answers to the same content deliberately survive. */
export function localBankEntryIdentity(entry: BankEntry): string {
  const key = localQuestionContentKey(entry.question);
  const answer = semanticAnswer(entry.question, entry.answer);
  return key && answer ? JSON.stringify([key, answer]) : JSON.stringify(entry);
}

export function matchLocalBank(question: QuestionSnapshot, entries: BankEntry[]): LocalBankMatch {
  if (!usable(question)) return { status: 'missing', message: '本地题库暂只匹配完整识别的纯文本题目。' };
  const key = localQuestionContentKey(question);
  if (!key) return { status: 'conflict', message: '题目含重复或空白选项，无法唯一匹配本地题库。' };
  const matches = new Map<string, ApplicableAnswer>();
  let invalid = false;
  for (const entry of entries) {
    if (localQuestionContentKey(entry.question) !== key) continue;
    const answer = remapAnswer(entry.question, question, entry.answer);
    if (!answer) { invalid = true; continue; }
    matches.set(JSON.stringify(answer), answer);
  }
  if (invalid || matches.size > 1) return { status: 'conflict', message: '本地题库存在冲突或无法映射的答案，请核对后处理。' };
  if (!matches.size) return { status: 'missing', message: '本地题库没有完整匹配的题目。' };
  return { status: 'matched', answer: [...matches.values()][0], message: '已按完整题目匹配本地题库，请核对答案。' };
}
