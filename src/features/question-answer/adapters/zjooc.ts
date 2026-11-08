import { assessmentSceneFromUrl } from '../../../platform/assessment-routes';
import { getDocumentPlatform } from '../../../shared/sites';
import { isZjoocReviewDocument } from '../../../platform/zjooc-review';
import { judgementMeaning } from '../../local-question-bank/semantic';
import type { QuestionKind } from '../types';
import { isPageVisible, normalizeText, questionText, signature, visible, type ChoiceControl, type PageInspection, type QuestionEntry } from './chaoxing';

/** DOM-based adapter: no private API, Vue internals, credentials or submit controls. */
export const ZJOOC_QUESTION_SELECTOR = '[data-question-id],.question-item,.questiono-item,.subject-item,.exam-question';
const documents = new WeakMap<Document, string>();
const papers = new WeakMap<Element, string>();
const STEM_SELECTOR = '[data-question-stem],.question-stem,.question-title,.subject-title,.topic-title';

function assessmentContext(win: Window): { scene?: 'exam' | 'homework'; href: string; documents: Document[] } {
  const documents = [win.document];
  let current = win;
  let scene = assessmentSceneFromUrl(win.document.URL);
  let href = win.document.URL;
  for (let depth = 0; depth < 3; depth++) {
    try {
      const parent = current.parent;
      if (parent === current || getDocumentPlatform(parent)?.id !== 'zjooc') break;
      // Reading parent.document is a same-origin probe, not an arbitrary frame traversal.
      const parentDocument = parent.document;
      documents.push(parentDocument);
      if (!scene) {
        const inherited = assessmentSceneFromUrl(parentDocument.URL);
        if (inherited) { scene = inherited; href = parentDocument.URL; }
      }
      current = parent;
    } catch { break; }
  }
  return { scene, href, documents };
}

function choicesFor(root: HTMLElement, images: string[]): ChoiceControl[] {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"],input[type="checkbox"]')];
  const nodes: HTMLElement[] = inputs.map(input => input.closest<HTMLElement>('label,.el-radio,.el-checkbox,[role="radio"],[role="checkbox"]') ?? input);
  for (const node of root.querySelectorAll<HTMLElement>('[role="radio"],[role="checkbox"],label.el-radio,label.el-checkbox')) {
    if (!nodes.some(other => other === node || other.contains(node) || node.contains(other))) nodes.push(node);
  }
  return [...new Set(nodes)].filter(visible).map((element, index) => {
    const input = element.matches('input') ? element as HTMLInputElement
      : element.querySelector<HTMLInputElement>('input[type="radio"],input[type="checkbox"]') ?? undefined;
    const textNode = element.querySelector('.el-radio__label,.el-checkbox__label,.option-text,.option-content') ?? element;
    const raw = questionText(textNode, images);
    const prefix = /^\s*([A-Z])[.．、:：)）]\s*/.exec(raw);
    const label = prefix?.[1] ?? String.fromCharCode(65 + index);
    const text = normalizeText(raw.replace(/^\s*[A-Z][.．、:：)）]\s*/, ''));
    return { element, input, state: element, option: { id: `option-${index + 1}`, label, text } };
  });
}

function entryFor(root: HTMLElement, index: number, complete: boolean): QuestionEntry {
  const images: string[] = [];
  const native = root.classList.contains('questiono-item');
  const group = root.closest('.common-question');
  const groupLabel = normalizeText(group?.previousElementSibling?.textContent ?? '');
  const groupNumber = group ? [...root.ownerDocument.querySelectorAll('.common-question')].indexOf(group) + 1 : 0;
  const itemNumber = group ? [...group.querySelectorAll('.questiono-item')].indexOf(root) + 1 : index + 1;
  const stemNode = root.querySelector(native ? '.questiono-header h6' : STEM_SELECTOR);
  const rawStem = stemNode ? questionText(stemNode, images) : '';
  const stem = native ? rawStem : rawStem.replace(/^\s*\d+\s*[.．、)）]\s*/, '');
  const choices = choicesFor(root, images);
  const textNodes = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea,input[type="text"],input:not([type])')]
    .filter(node => visible(node) && !node.closest('[data-cx-toolbox],.answer-analysis,.reference-answer,.analysis'));
  const hint = [root.getAttribute('data-question-type'), root.querySelector('.question-type,.subject-type,[data-question-type]')?.textContent, native ? groupLabel : ''].join(' ');
  const unsupportedType = /连线|匹配|阅读|完形|程序|编程|排序|附件|上传/.test(hint);
  let kind: QuestionKind = 'unsupported';
  if (!unsupportedType && choices.length && !textNodes.length) {
    const multiple = choices.every(choice => choice.input?.type === 'checkbox' || choice.element.getAttribute('role') === 'checkbox' || choice.element.classList.contains('el-checkbox'));
    const single = choices.every(choice => choice.input?.type === 'radio' || choice.element.getAttribute('role') === 'radio' || choice.element.classList.contains('el-radio'));
    if (multiple) kind = 'multiple';
    else if (single) kind = /判断/.test(hint) || choices.length === 2 && choices.every(choice => /^(?:正确|错误|对|错|是|否|true|false|√|×)$/i.test(choice.option.text)) ? 'judgement' : 'single';
  } else if (!unsupportedType && !choices.length && textNodes.length) kind = 'completion';
  const texts = textNodes.map((element, field) => ({ id: `field-${field + 1}`, element, waiting: false }));
  const fields = kind === 'completion' ? texts.map(({ id }) => ({ id })) : [];
  const options = choices.map(choice => choice.option);
  const fingerprint = signature(JSON.stringify([kind, stem, options, fields, images]));
  const sourceId = root.getAttribute('data-question-id') || root.getAttribute('data-id') || root.id || (native ? `group-${groupNumber}:item-${itemNumber}` : `content-${fingerprint}`);
  const readOnly = complete || Boolean(root.closest('[aria-readonly="true"],[data-readonly="true"],.exam-result,.exam-review'));
  const supported = Boolean(stem && kind !== 'unsupported' && (!choices.length || choices.every(choice => choice.option.text)));
  const reviewLabel = root.querySelector('.common_test_myanswer');
  const myAnswer = normalizeText(reviewLabel?.nextElementSibling?.textContent ?? '');
  const reviewedChoices = kind === 'judgement'
    ? choices.filter(choice => judgementMeaning(choice.option.text) === (myAnswer === 'yes' ? true : myAnswer === 'no' ? false : judgementMeaning(myAnswer))
      && judgementMeaning(choice.option.text) !== undefined)
    : choices.filter(choice => myAnswer.split(/[,，、\s]+/).includes(choice.option.label));
  const groupKind = /判断/.test(groupLabel) ? '判断' : /多选/.test(groupLabel) ? '多选' : /单选/.test(groupLabel) ? '单选' : `分组${groupNumber}`;
  return {
    root, sourceId, choices, texts, matches: [], children: [], readOnly,
    snapshot: {
      key: `zjooc:${sourceId}`, fingerprint, number: root.getAttribute('data-question-number') || (native ? `${groupKind} ${normalizeText(root.querySelector('.questiono-header > b.fl')?.textContent ?? '').replace(/[.．、]$/, '') || itemNumber}` : String(index + 1)),
      kind, stem, options, fields, children: [], images, supported,
      ...(complete && reviewLabel ? { reviewData: {
        answer: reviewedChoices.length ? { choices: reviewedChoices.map(choice => choice.option.id) } : {},
        score: normalizeText(root.querySelector('.common_test_score')?.nextElementSibling?.textContent ?? ''),
        maxScore: normalizeText(root.querySelector('.questiono-header .fr')?.textContent ?? ''),
        explanation: normalizeText(root.querySelector('.common_test_html')?.textContent ?? '').slice(0, 32000),
      } } : {}),
      ...(!supported ? { reason: !stem ? '未找到可核对的题干。' : '当前题型或答题控件尚未适配，需手动处理。' } : {}),
    },
  };
}

export function inspectZjoocQuestionPage(win: Window): PageInspection {
  const doc = win.document;
  let documentKey = documents.get(doc);
  if (!documentKey) { documentKey = `zjooc-document:${win.crypto.randomUUID()}`; documents.set(doc, documentKey); }
  const context = assessmentContext(win);
  const reviewPage = isZjoocReviewDocument(doc);
  const scene = getDocumentPlatform(win)?.id === 'zjooc' && isPageVisible(win) ? context.scene ?? (reviewPage ? 'exam' : 'unsupported') : 'unsupported';
  const complete = reviewPage || context.documents.some(current => [...current.querySelectorAll('[data-exam-status],.exam-status,.paper-status')]
    .filter(visible).some(node => /^(?:已交卷|考试已结束|已提交|已批阅|查看成绩)$/.test(normalizeText(node.getAttribute('data-exam-status') || node.textContent || '')))
    || [...current.querySelectorAll('.exam-result,.exam-review,[data-paper-readonly="true"]')].some(visible));
  const roots = scene === 'unsupported' ? [] : [...doc.querySelectorAll<HTMLElement>(ZJOOC_QUESTION_SELECTOR)]
    .filter(node => visible(node) && !node.closest('[data-cx-toolbox],#cx-toolbox-root') && !node.parentElement?.closest(ZJOOC_QUESTION_SELECTOR));
  const entries = roots.map((root, index) => entryFor(root, index, complete));
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.snapshot.key) || entries.filter(other => other.snapshot.key === entry.snapshot.key).length !== 1) {
      entry.snapshot.supported = false; entry.snapshot.reason = '题目标识重复，无法唯一定位。';
    }
    keys.add(entry.snapshot.key);
  }
  const paper = roots[0]?.closest('main.common_look,form,.exam-paper,.exam-content,.question-list,.subject-list') ?? doc.body ?? doc.documentElement;
  let paperKey = paper ? papers.get(paper) : undefined;
  if (paper && !paperKey) { paperKey = win.crypto.randomUUID(); papers.set(paper, paperKey); }
  const identifiers = [...doc.querySelectorAll<HTMLInputElement>('input[name="examId"],input[name="paperId"],input[name="testId"]')].map(node => [node.name, node.value]);
  const title = normalizeText(doc.querySelector('.exam-title,.paper-title,main.common_look h6.ft18')?.textContent ?? '');
  const scopeKey = signature(JSON.stringify([doc.URL, context.href, identifiers, title, paperKey]));
  const groups = [...doc.querySelectorAll('.common-question')].filter(visible);
  const completeReview = reviewPage && groups.length > 0 && groups.every(group => {
    const declared = /共\s*(\d+)\s*题/.exec(group.previousElementSibling?.textContent ?? '');
    return declared && Number(declared[1]) === entries.filter(entry => entry.root.closest('.common-question') === group).length;
  }) && ![...doc.querySelectorAll('.el-pagination,[data-pagination]')].some(visible);
  return { entries, snapshot: {
    documentKey, scopeKey, scene, questions: entries.map(entry => entry.snapshot), complete,
    // DOM count is not proof of the entire paper. Independent exams never use finish.
    allLoaded: Boolean(completeReview), canSave: false, canSubmit: false,
    ...(scene === 'unsupported' ? { reason: '请进入浙学的考试或作业答题页后重新识别。' }
      : !entries.length ? { reason: '未读取到支持的题目结构；请等待题目加载后刷新阅览，仍无结果则需要补充页面适配。' } : {}),
  } };
}
