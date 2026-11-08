import type { ApplicableAnswer, AnswerControlSnapshot, QuestionKind, QuestionOption, QuestionPageSnapshot, QuestionSnapshot } from '../types';
import { readQuestionTextDetails, type QuestionTextRead } from '../../question-font';
import { normalizeProgramCode } from '../normalize';
import { assessmentSceneFromUrl } from '../../../platform/assessment-routes';

export interface AnswerEditor {
  isReady?: boolean | number; iframe?: HTMLIFrameElement; body?: HTMLElement; container?: HTMLElement;
  getContent(): string; setContent(html: string, append?: boolean): void; fireEvent(event: string): void; sync?(): void;
}
export interface ChoiceControl { option: QuestionOption; element: HTMLElement; input?: HTMLInputElement; state: Element }
export interface TextControl { id: string; element: HTMLTextAreaElement | HTMLInputElement; editor?: AnswerEditor; waiting: boolean }
export interface MatchControl { id: string; element: HTMLSelectElement | HTMLInputElement; options: Array<{ option: QuestionOption; value: string; element: HTMLElement }> }
export interface ChildControl { id: string; choices: ChoiceControl[] }
export interface ProgramControl {
  editor?: { getValue(): string; setValue(value: string): void; getOption?(name: string): unknown };
  language: string; languageId: string; template: string; saved: string; waiting: boolean; readOnly: boolean;
}
export interface QuestionEntry {
  root: HTMLElement; snapshot: QuestionSnapshot; sourceId: string; choices: ChoiceControl[];
  texts: TextControl[]; matches: MatchControl[]; children: ChildControl[]; program?: ProgramControl; readOnly?: boolean;
}
export interface PageInspection { snapshot: QuestionPageSnapshot; entries: QuestionEntry[] }

const documents = new WeakMap<Document, string>();
const excluded = 'script,style,noscript,iframe,textarea,input,select,button,[data-cx-toolbox],#cx-toolbox-root,.stem_answer,.stem_answer2,.studentAnswer,.student-answer,.Py_answer,.mark_answer,.answer-analysis,.answerAnalysis,.analysis,.reference-answer,.colorShallow,.question-type,.question-number';

export function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
}
export function signature(value: string): string {
  let hash = 2166136261;
  let second = 5381;
  for (let i = 0; i < value.length; i += 1) { hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ value.charCodeAt(i); }
  return `${value.length}-${(hash >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}
export function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
}
export function isPageVisible(win: Window): boolean {
  try { return !win.frameElement || visible(win.frameElement); } catch { return true; }
}
export function imageAddress(image: Element): string | undefined {
  const current = (image as HTMLImageElement).currentSrc;
  const value = image.getAttribute('data-original') || image.getAttribute('data-src') || image.getAttribute('data-lazy-src')
    || image.getAttribute('data-url') || current || image.getAttribute('srcset')?.split(',').at(-1)?.trim().split(/\s+/)[0] || image.getAttribute('src');
  if (!value) return undefined;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(value)) return value;
  try {
    const url = new URL(value, image.baseURI);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** Only question-owned content is read; answer/editing areas are deliberately omitted. */
type TextReads = Map<Node, QuestionTextRead & { original: string }>;
export function questionText(element: Element, images: string[], omitChoices = false, reads?: TextReads): string {
  function walk(node: Node): string {
    if (node.nodeType === 3) {
      const result = readQuestionTextDetails(node);
      reads?.set(node, { ...result, original: node.textContent ?? '' });
      return result.text;
    }
    if (node.nodeType !== 1) return '';
    const current = node as Element;
    if (current !== element && (current.matches(excluded) || (omitChoices && current.matches('.saveSingleSelect')))) return '';
    if (current.hasAttribute('hidden') || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(current.getAttribute('style') ?? '')) return '';
    if (current.tagName === 'MJX-CONTAINER' || current.tagName === 'MATH') {
      // MathJax SVG output has no readable text nodes; the original TeX is the only faithful source.
      const latex = current.getAttribute('data-latex') ?? current.querySelector('[data-latex]')?.getAttribute('data-latex') ?? current.getAttribute('alttext');
      if (latex?.trim()) return `$${latex.trim()}$`;
    }
    if (current.tagName === 'IMG') {
      const url = imageAddress(current);
      if (!url) return '[图片地址不可用]';
      if (!images.includes(url)) images.push(url);
      return `[图片${images.indexOf(url) + 1}]`;
    }
    if (current.tagName === 'BR') return '\n';
    const text = Array.from(current.childNodes, walk).join('');
    return /^(P|DIV|LI|TR|PRE|H[1-6])$/.test(current.tagName) ? `${text}\n` : text;
  }
  return normalizeText(walk(element)).replace(/\n{3,}/g, '\n\n');
}

function kindFor(number: number): QuestionKind {
  return number === 0 ? 'single' : number === 1 ? 'multiple' : number === 3 ? 'judgement'
    : [2, 4, 5, 6, 7, 8, 9, 10].includes(number) ? 'completion' : number === 11 ? 'line'
      : number === 14 ? 'fill' : number === 15 ? 'reader' : number === 17 ? 'program' : 'unsupported';
}
function disabled(element: Element): boolean {
  return Boolean(element.closest('[aria-disabled="true"],fieldset[disabled]')) || element.matches(':disabled,[readonly],[aria-readonly="true"],[contenteditable="false"]');
}
function ancestorState(element: HTMLElement, root: Element): Element {
  const row = element.closest('li,.answer_item,.answerItem');
  if (row && row !== root) return row;
  const parent = element.parentElement;
  return parent && parent !== root && parent.querySelectorAll('.answer_p').length <= 1 ? parent : element;
}
function makeChoices(nodes: HTMLElement[], root: Element, images: string[], child = false, reads?: TextReads): ChoiceControl[] {
  const used = new Set<Element>();
  return nodes.flatMap((element): ChoiceControl[] => {
    const state = child ? element : ancestorState(element, root);
    if (used.has(state)) return [];
    const index = used.size;
    used.add(state);
    const inputs = Array.from(state.querySelectorAll<HTMLInputElement>('input[type=radio],input[type=checkbox]'));
    const input = inputs.length === 1 ? inputs[0] : undefined;
    let text = questionText(element, images, false, reads);
    const labelElement = state.querySelector('.before,.answerTag,.option-letter');
    const label = child ? element.getAttribute('data') ?? '' : /^\s*([A-Z])(?:[.．、:：)）]|\s|$)/.exec(labelElement?.textContent ?? text)?.[1] ?? String.fromCharCode(65 + index);
    text = text.replace(/^\s*[A-Z][.．、:：)）]\s*/, '').trim();
    if (!text && state.querySelector('.ri')) text = '正确';
    if (!text && state.querySelector('.wr')) text = '错误';
    return [{ option: { id: `option-${index + 1}`, label, text }, element, input, state }];
  });
}
function editors(win: Window): AnswerEditor[] {
  const value = (win as Window & { UE?: { instants?: Record<string, AnswerEditor> } }).UE?.instants;
  return value && typeof value === 'object' ? Object.values(value) : [];
}
function textControls(win: Window, root: HTMLElement, chapter: boolean): TextControl[] {
  const hosts = chapter ? ['ul'] : ['.textDIV', '.eidtDiv'];
  const selector = hosts.flatMap(host => [`${host} textarea`, `${host} input[type=text]`, `${host} input:not([type])`]).join(',');
  const nodes = Array.from(root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(selector))
    .filter(element => !/^(?:questionIds?|workAnswerId|workId|paperId|jobid|type\d*|answertype.*)$/i.test(element.name || element.id));
  return nodes.map((element, index) => {
    const host = element.closest('.textDIV,.eidtDiv') ?? element.parentElement!;
    const candidates = editors(win).filter(editor => editor?.iframe && root.contains(editor.iframe)
      && (host.contains(editor.iframe) || Boolean(editor.container?.contains(element))));
    const editor = candidates.length === 1 ? candidates[0] : undefined;
    const waiting = candidates.length > 1 || Boolean(host.querySelector('iframe')) && !editor
      || Boolean(editor && (!editor.isReady || !editor.body || editor.iframe?.contentDocument?.body !== editor.body
        || typeof editor.getContent !== 'function' || typeof editor.setContent !== 'function' || typeof editor.fireEvent !== 'function'));
    return { id: `field-${index + 1}`, element, editor, waiting };
  });
}
function matchControls(root: HTMLElement, chapter: boolean, images: string[], reads: TextReads): MatchControl[] {
  if (chapter) {
    return Array.from(root.querySelectorAll<HTMLSelectElement>('.thirdUlList select.dept_select')).map((element, index) => ({
      id: `field-${index + 1}`, element,
      options: Array.from(element.options).filter(option => option.value && !option.disabled).map((option, i) => ({
        option: { id: `match-${i + 1}`, label: option.value, text: questionText(option, images, false, reads) }, value: option.value, element: option,
      })),
    }));
  }
  const boxes = Array.from(root.querySelectorAll<HTMLElement>('.line_answer_ct .selectBox'));
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('.line_answer input[name^=answer]'));
  if (boxes.length !== inputs.length) return [];
  return boxes.map((box, index) => ({ id: `field-${index + 1}`, element: inputs[index],
    options: Array.from(box.querySelectorAll<HTMLElement>('li[data] a')).map((element, i) => ({
      option: { id: `match-${i + 1}`, label: element.parentElement!.getAttribute('data') ?? '', text: questionText(element, images, false, reads) },
      value: element.parentElement!.getAttribute('data') ?? '', element,
    })),
  }));
}

type ProgramEditor = { getValue(): string; setValue(value: string): void; getOption?(name: string): unknown };
type ProgramWindow = Window & { codeEditors?: Record<string, ProgramEditor> };
function programRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function programEditor(win: Window, root: HTMLElement, qid: string): ProgramEditor | undefined {
  const wrapper = root.querySelector<HTMLElement & { CodeMirror?: ProgramEditor }>('.codeEditWrap .CodeMirror, .codeEditorBoxDiv .CodeMirror')
    ?? root.querySelector<HTMLElement & { CodeMirror?: ProgramEditor }>('.CodeMirror');
  const candidate = wrapper?.CodeMirror ?? (win as ProgramWindow).codeEditors?.[qid];
  return candidate && typeof candidate.getValue === 'function' && typeof candidate.setValue === 'function' ? candidate : undefined;
}
function programLanguage(root: HTMLElement): { language: string; languageId: string } {
  const label = normalizeText(root.querySelector('.langList p span')?.textContent ?? '');
  const codeName = normalizeText(root.querySelector<HTMLElement>('.langList')?.getAttribute('codename') ?? '');
  const chosen = (value: string) => value && !/^请选择程序语言$/.test(value) ? value : '';
  const languageId = normalizeText(root.querySelector<HTMLInputElement>('input.languageSelect')?.value ?? '') || '-1';
  return { language: chosen(label) || chosen(codeName) || '未指定', languageId };
}
function programTemplate(root: HTMLElement, language: string, languageId: string): string {
  const raw = root.querySelector<HTMLElement>('.codeEditorBoxDiv[prepared-code]')?.getAttribute('prepared-code');
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return '';
    const entries = parsed.map(programRecord).filter((item): item is Record<string, unknown> => Boolean(item));
    const match = entries.find(item => String(item.codeNum ?? '') === languageId)
      ?? entries.find(item => normalizeText(String(item.codeName ?? '')) === language) ?? entries[0];
    return typeof match?.code === 'string' ? normalizeProgramCode(match.code) ?? '' : '';
  } catch { return ''; }
}
/** The page stores [{language, answer(html), answerTxt(plain code)}]; read the plain mirror, never the html. */
export function readSavedProgramCode(root: HTMLElement, qid: string, languageId: string): string {
  const input = Array.from(root.querySelectorAll<HTMLInputElement>('input[name^="answer"]')).find(element => element.name === `answer${qid}`);
  const raw = input?.value.trim() ?? '';
  if (!raw) return '';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const entries = parsed.map(programRecord).filter((item): item is Record<string, unknown> => Boolean(item));
      const match = entries.find(item => String(item.language ?? '') === languageId) ?? entries[0];
      if (typeof match?.answerTxt === 'string') return normalizeProgramCode(match.answerTxt) ?? '';
    }
  } catch { /* Older templates may store plain code. */ }
  return normalizeProgramCode(raw) ?? '';
}
function programControl(win: Window, root: HTMLElement, qid: string): ProgramControl {
  const { language, languageId } = programLanguage(root);
  const editor = programEditor(win, root, qid);
  return {
    editor, language, languageId,
    template: programTemplate(root, language, languageId),
    saved: readSavedProgramCode(root, qid, languageId),
    waiting: !editor,
    readOnly: Boolean(editor?.getOption?.('readOnly')),
  };
}

function entryFor(win: Window, root: HTMLElement, index: number, chapter: boolean): QuestionEntry {
  const images: string[] = [];
  const reads: TextReads = new Map();
  const typeNodes = Array.from(root.querySelectorAll<HTMLInputElement>('input[id^=answertype],input[name^=type]'));
  const codes = [...new Set(typeNodes.map(node => node.value).filter(value => /^\d+$/.test(value)))];
  let kind = codes.length === 1 ? kindFor(Number(codes[0])) : 'unsupported';
  if (chapter && (kind === 'fill' || kind === 'reader')) kind = 'unsupported';
  const title = chapter ? root.querySelector('.Zy_TItle .clearfix') ?? root.querySelector('.Zy_TItle')
    : root.querySelector('.splitS-left .mark_name,.mark_name');
  const number = /^\s*(\d+)[.．、)）]?/.exec(title?.textContent ?? '')?.[1] ?? String(index + 1);
  let stem = title ? questionText(title, images, false, reads).replace(/^\s*\d+[.．、)）]\s*/, '').replace(/^\s*[(（【][^\n)）】]*(?:题|名词解释|完形填空|阅读理解)[^\n)）】]*[)）】]\s*/, '').trim() : '';
  if (kind === 'line') {
    stem += Array.from(root.querySelectorAll('.firstUlList,.secondUlList'), node => `\n${questionText(node, images, false, reads)}`).join('');
  }
  const sourceId = root.getAttribute('data-question-id') || root.querySelector<HTMLInputElement>('input[name=questionId]')?.value
    || typeNodes[0]?.id.replace(/^answertype/, '') || root.id;
  const program = kind === 'program' ? programControl(win, root, sourceId) : undefined;
  const choiceNodes = chapter ? Array.from(root.querySelectorAll<HTMLElement>('ul li .after,ul li label:not(.before)'))
    : Array.from(root.querySelectorAll<HTMLElement>('.answerBg .answer_p'));
  const choices = ['single', 'multiple', 'judgement'].includes(kind) ? makeChoices(choiceNodes, root, images, false, reads) : [];
  const texts = kind === 'completion' ? textControls(win, root, chapter) : [];
  const matches = kind === 'line' ? matchControls(root, chapter, images, reads) : [];
  const children = ['reader', 'fill'].includes(kind) ? Array.from(root.querySelectorAll<HTMLElement>(kind === 'reader' ? '.reading_answer' : '.filling_answer')).map((child, i) => ({
    id: `child-${i + 1}`, stem: questionText(child, images, true, reads), choices: makeChoices(Array.from(child.querySelectorAll<HTMLElement>('span.saveSingleSelect[data]')), child, images, true, reads),
  })) : [];
  let reason = !sourceId ? '题目缺少稳定标识。' : !stem ? '未识别到完整题干。' : kind === 'unsupported' ? '暂不支持此题型，请手动作答。' : '';
  const textReads = [...reads.values()];
  const unresolved = textReads.flatMap(read => read.unresolved);
  const unresolvedCount = unresolved.reduce((sum, item) => sum + item.count, 0);
  const pending = textReads.some(read => read.pending);
  // Font preparation can wait, but must never replace a structural rejection.
  if (!reason && pending) reason = '正在准备本页加密文字，请稍候重新读取。';
  const recognitionOversized = unresolved.length > 1024 || unresolved.some(item => item.raw.length > 32000)
    || unresolved.reduce((sum, item) => sum + item.raw.length, 0) > 128000;
  if (kind === 'program' && program) {
    if (program.languageId === '-1' || program.language === '未指定') reason = '请先在页面上选择程序语言。';
    else if (program.waiting) reason = root.querySelector('.ace_editor,.monaco-editor') ? '当前程序题编辑器模板暂不支持。' : '编程编辑器尚未就绪，请稍候重新读取。';
  } else if (root.querySelector('.CodeMirror,.ace_editor,.monaco-editor,.codeEditWrap,.proceduralQue')) reason = '专用编程编辑器暂不支持。';
  if (['single', 'multiple', 'judgement'].includes(kind) && (choices.length < 2 || choices.some(item => !item.option.text))) reason = '选项结构不完整。';
  if (kind === 'completion' && (!texts.length || texts.some(item => item.waiting))) reason = '文本答题控件未就绪或结构暂不支持。';
  if (kind === 'line' && (!matches.length || matches.some(item => !item.options.length || item.options.some(option => !option.value)))) reason = '连线控件结构不完整。';
  if (['fill', 'reader'].includes(kind) && (!children.length || children.some(child => child.choices.length < 2))) reason = '阅读／完形子题结构不完整。';
  if (images.length > 16 || JSON.stringify([stem, choices.map(choice => choice.option), matches.map(field => field.options.map(option => option.option)), children.map(child => [child.stem, child.choices.map(choice => choice.option)])]).includes('[图片地址不可用]')) reason = '题目图片过多或包含不可用地址。';
  const snapshot: QuestionSnapshot = { key: `question:${signature(sourceId || `missing-${index}`)}`, fingerprint: '', number, kind, stem,
    options: choices.map(item => item.option), fields: kind === 'line' ? matches.map(item => ({ id: item.id, options: item.options.map(option => option.option) })) : texts.map(item => ({ id: item.id })),
    children: children.map(child => ({ id: child.id, stem: child.stem, options: child.choices.map(item => item.option) })), images,
    ...(program ? { program: { language: program.language } } : {}),
    supported: !reason, ...(reason ? { reason } : {}),
    ...(unresolvedCount && !recognitionOversized ? { textRecognition: {
      status: pending ? 'pending' as const : textReads.some(read => read.recognizedCount) ? 'partial' as const : 'unavailable' as const,
      unresolvedCount, unresolved,
    } } : {}),
  };
  // Include original question-only text so different undecoded codes cannot share a placeholder identity.
  snapshot.fingerprint = signature(JSON.stringify([snapshot.kind, snapshot.stem, snapshot.options, snapshot.fields, snapshot.children, snapshot.images, snapshot.program,
    signature(JSON.stringify(textReads.map(read => read.original)))]));
  // An unsupported oversized question still needs a transportable explanation.
  // No partially truncated image set may become an answer request.
  const imagePayloadInvalid = images.length > 16 || images.some(image => image.length > (image.startsWith('data:') ? 4_000_000 : 4096))
    || images.filter(image => image.startsWith('data:')).reduce((size, image) => size + image.length, 0) > 12_000_000;
  const textPayloadInvalid = recognitionOversized || snapshot.stem.length > 32000 || snapshot.options.some(option => option.text.length > 16000)
    || snapshot.fields.some(field => field.options?.some(option => option.text.length > 16000))
    || snapshot.children.some(child => child.stem.length > 16000 || child.options.some(option => option.text.length > 16000));
  if (imagePayloadInvalid || textPayloadInvalid) {
    snapshot.supported = false;
    snapshot.reason = '题目内容或图片超过处理上限，请手动处理。';
    if (imagePayloadInvalid) snapshot.images = [];
    snapshot.stem = snapshot.stem.slice(0, 32000);
    const shorten = (option: QuestionOption) => { option.text = option.text.slice(0, 16000); };
    snapshot.options.forEach(shorten);
    snapshot.fields.forEach(field => field.options?.forEach(shorten));
    snapshot.children.forEach(child => { child.stem = child.stem.slice(0, 16000); child.options.forEach(shorten); });
  }
  return { root, snapshot, sourceId, choices, texts, matches, children, ...(program ? { program } : {}) };
}

export function pageComplete(doc: Document): boolean {
  return Boolean(Array.from(doc.querySelectorAll('.testTit_status_complete')).some(visible));
}
export function chapterAction(win: Window, action: 'save' | 'submit' | 'confirm'): HTMLElement | undefined {
  const method = action === 'save' ? 'noSubmit' : action === 'submit' ? 'btnBlueSubmit' : 'submitCheckTimes';
  if (typeof (win as unknown as Record<string, unknown>)[method] !== 'function') return undefined;
  const targets = Array.from(win.document.querySelectorAll<HTMLElement>('[onclick]')).filter(element => {
    const code = (element.getAttribute('onclick') ?? '').trim();
    return new RegExp(`^(?:return\\s+)?(?:window\\.)?${method}\\(\\s*\\)\\s*;?$`).test(code) && visible(element) && !disabled(element);
  });
  return targets.length === 1 ? targets[0] : undefined;
}

/** The observed form1 chapter template declares both paper and per-type counts. */
function chapterFormCensus(doc: Document, entries: QuestionEntry[]): boolean {
  const forms = doc.querySelectorAll('form#form1');
  if (forms.length !== 1 || !entries.length) return false;
  const form = forms[0];
  const container = form.closest('.newTestCon');
  if (!container || !container.querySelector('.newTestTitle .testTit_status')) return false;
  const totals = Array.from(container.querySelectorAll('.ceyan_name p span'))
    .map(node => /^题量\s*[:：]\s*(\d+)$/.exec(normalizeText(node.textContent ?? '')))
    .filter((value): value is RegExpExecArray => Boolean(value));
  if (totals.length !== 1 || Number(totals[0][1]) !== entries.length) return false;
  const wrappers = Array.from(form.querySelectorAll<HTMLElement>('.singleQuesId'));
  if (wrappers.length !== entries.length || wrappers.some(wrapper => !visible(wrapper))) return false;
  if (new Set(entries.map(entry => entry.sourceId)).size !== entries.length) return false;
  if (entries.some((entry, index) => entry.root.closest('.singleQuesId') !== wrappers[index]
    || wrappers[index].querySelectorAll('.TiMu').length !== 1
    || wrappers[index].getAttribute('data') !== entry.sourceId
    || wrappers[index].id !== `question${entry.sourceId}`)) return false;
  const sections = Array.from(form.querySelectorAll('h3.newTestType'));
  if (!sections.length) return false;
  let counted = 0;
  for (const [index, heading] of sections.entries()) {
    const match = /(?:单选题|多选题|填空题|判断题)\s*[（(]共\s*(\d+)\s*题[）)]/.exec(normalizeText(heading.textContent ?? ''));
    if (!match) return false;
    const group = wrappers.filter(wrapper => Boolean(heading.compareDocumentPosition(wrapper) & 4)
      && (!sections[index + 1] || Boolean(wrapper.compareDocumentPosition(sections[index + 1]) & 4)));
    if (group.length !== Number(match[1])) return false;
    counted += group.length;
  }
  return counted === entries.length;
}

/** Standalone homework/exam pages must declare the same paper size three independent ways. */
function homeworkExamCensus(doc: Document, entries: QuestionEntry[], paginated: boolean): boolean {
  if (paginated) return false;
  const containers = doc.querySelectorAll('#fanyaMarking');
  if (containers.length !== 1 || !entries.length) return false;
  const container = containers[0];
  if (!visible(container)) return false;
  const totalNodes = Array.from(container.querySelectorAll('.mark_info'));
  if (totalNodes.some(node => !visible(node))) return false;
  const totals = totalNodes
    .flatMap(node => Array.from(normalizeText(node.textContent ?? '').matchAll(/题量\s*[:：]\s*(\d+)/g)))
    .map(match => Number(match[1]));
  if (totals.length !== 1 || totals[0] !== entries.length) return false;

  const questionNodes = Array.from(container.querySelectorAll<HTMLElement>('.questionLi'));
  if (questionNodes.length !== entries.length || questionNodes.some(node => !visible(node))) return false;
  if (new Set(entries.map(entry => entry.sourceId)).size !== entries.length) return false;
  if (entries.some((entry, index) => entry.root !== questionNodes[index]
      || entry.root.parentElement?.closest('.questionLi')
      || entry.root.closest('#fanyaMarking') !== container)) return false;

  const headings = Array.from(container.querySelectorAll<HTMLElement>('.type_tit'));
  if (!headings.length || headings.some(heading => !visible(heading))) return false;
  let counted = 0;
  for (const [index, heading] of headings.entries()) {
    const match = /共\s*(\d+)\s*题/.exec(normalizeText(heading.textContent ?? ''));
    if (!match) return false;
    const group = questionNodes.filter(node => Boolean(heading.compareDocumentPosition(node) & 4)
      && (!headings[index + 1] || Boolean(node.compareDocumentPosition(headings[index + 1]) & 4)));
    if (group.length !== Number(match[1])) return false;
    counted += group.length;
  }
  return counted === totals[0];
}

/** This is an observed frame, never a traversal into arbitrary parent/editor documents. */
export function inspectQuestionPage(win: Window): PageInspection {
  const doc = win.document;
  let documentKey = documents.get(doc);
  if (!documentKey) { documentKey = `answer-document:${win.crypto.randomUUID()}`; documents.set(doc, documentKey); }
  const url = new URL(doc.location.href);
  const allowed = /(^|\.)chaoxing\.com$/.test(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  const chapter = Boolean(doc.querySelector('.TiMu')) && (Boolean(doc.querySelector('.testTit_status')) || ['jobid', '_jobid', 'knowledgeid', 'knowledgeId'].some(key => url.searchParams.has(key)));
  const scene: QuestionPageSnapshot['scene'] = !allowed || !isPageVisible(win) ? 'unsupported'
    : chapter ? 'chapter-test' : assessmentSceneFromUrl(url.href) ?? 'unsupported';
  const identityValues = Array.from(doc.querySelectorAll<HTMLInputElement>('input[name=workAnswerId],input[name=workId],input[name=examId],input[name=paperId],input[name=jobid],#workId,#workAnswerId,#paperId')).map(node => [node.name || node.id, node.value]);
  const scopeKey = signature(JSON.stringify([url.href, identityValues, doc.querySelector<HTMLFormElement>('form#submitForm,form#form1')?.getAttribute('action') ?? '']));
  const roots = scene === 'unsupported' ? [] : Array.from(doc.querySelectorAll<HTMLElement>(chapter ? '.TiMu' : '.questionLi'))
    .filter(root => visible(root) && !root.closest('[data-cx-toolbox],#cx-toolbox-root') && !root.parentElement?.closest(chapter ? '.TiMu' : '.questionLi'));
  const entries = roots.map((root, index) => entryFor(win, root, index, chapter));
  for (const entry of entries) {
    if (entries.filter(other => other.snapshot.key === entry.snapshot.key).length !== 1) { entry.snapshot.supported = false; entry.snapshot.reason = '题目标识重复，无法安全定位。'; }
  }
  // A visible DOM count alone is not a paper census. Only known full-paper declarations qualify.
  const censusValues = Array.from(doc.querySelectorAll<HTMLInputElement>('input#questionIds,input[name=questionIds]')).map(node => node.value.trim());
  const declared = censusValues.length === 1 ? censusValues[0].split(/[,，\s]+/).filter(Boolean) : [];
  const idCensus = entries.length > 0 && declared.length === entries.length && new Set(declared).size === declared.length
    && entries.every(entry => declared.includes(entry.sourceId));
  const paginated = Boolean(doc.querySelector([
    '[onclick*="getTheNextQuestion"]', '[onclick*="nextQuestion"]',
    '.pagination', '.pager', '.layui-laypage', '[class~="pagination"]', '[class~="pager"]',
    '[rel=next]', '[rel=prev]', 'input[name=pageNum]', 'input[name=currentPage]',
  ].join(',')));
  const allLoaded = !paginated && (idCensus
    || (chapter && !censusValues.length && chapterFormCensus(doc, entries))
    || (['homework', 'exam'].includes(scene) && homeworkExamCensus(doc, entries, paginated)));
  const complete = pageComplete(doc);
  const actionReady = scene === 'chapter-test' && Boolean(doc.querySelector('.testTit_status')) && !complete && entries.length > 0;
  return { entries, snapshot: { documentKey, scopeKey, scene, questions: entries.map(entry => entry.snapshot), complete, allLoaded,
    canSave: actionReady && Boolean(chapterAction(win, 'save')), canSubmit: actionReady && allLoaded && Boolean(chapterAction(win, 'submit')),
    ...(scene === 'unsupported' ? { reason: '当前框架不是受支持的章节测验、作业或考试题目页面。' } : !entries.length ? { reason: '题目尚未加载。' } : {}),
  } };
}

function choiceSelected(choice: ChoiceControl): boolean {
  if (choice.input) return choice.input.checked;
  return [choice.element, choice.state, choice.element.parentElement].some(element => element?.getAttribute('aria-checked') === 'true'
    || Array.from(element?.classList ?? []).some(name => name.startsWith('check_answer') || name === 'is-checked')
    || Boolean(element?.querySelector('[class*="check_answer"]')));
}
function richText(doc: Document, html: string): { text: string; hasMedia: boolean } {
  const template = doc.createElement('template');
  template.innerHTML = html;
  function walk(node: Node): string {
    if (node.nodeType === 3) return node.textContent ?? '';
    const element = node as Element;
    if (element.tagName === 'BR') return '\n';
    const text = Array.from(node.childNodes, walk).join('');
    return ['P', 'DIV', 'PRE', 'LI'].includes(element.tagName) ? `${text}\n` : text;
  }
  return { text: normalizeText(walk(template.content)), hasMedia: Boolean(template.content.querySelector('img,math,svg,video,audio,object,iframe,canvas,table,hr,[data-latex]')) };
}
function editorText(editor: AnswerEditor): { text: string; hasMedia: boolean } {
  return richText(editor.body!.ownerDocument, editor.getContent());
}

export function readQuestionControl(win: Window, entry: QuestionEntry): AnswerControlSnapshot {
  const question = entry.snapshot;
  const answer: ApplicableAnswer = {};
  let hasContent = false;
  const codeEditor = question.kind === 'program' ? entry.program?.editor : undefined;
  const programCode = codeEditor ? normalizeProgramCode(codeEditor.getValue()) ?? '' : '';
  const programSaved = question.kind === 'program' ? entry.program?.saved ?? '' : '';
  const programTemplate = question.kind === 'program' ? entry.program?.template ?? '' : '';
  const programTemplateOnly = Boolean(programCode) && !programSaved && programCode === programTemplate;
  if (['single', 'multiple', 'judgement'].includes(question.kind)) { answer.choices = entry.choices.filter(choiceSelected).map(item => item.option.id); hasContent = answer.choices.length > 0; }
  if (entry.readOnly && question.reviewData?.answer.choices?.length && !hasContent) {
    answer.choices = [...question.reviewData.answer.choices]; hasContent = true;
  }
  if (question.kind === 'program') {
    // A page-provided skeleton is not an answer; a saved draft is.
    answer.code = programTemplateOnly ? '' : programCode || programSaved;
    hasContent = Boolean(programSaved) || Boolean(programCode && programCode !== programTemplate);
  }
  if (question.kind === 'completion') {
    const values = entry.texts.map(item => item.editor && !item.waiting ? editorText(item.editor)
      : item.waiting ? richText(win.document, item.element.value) : { text: normalizeText(item.element.value), hasMedia: false });
    answer.texts = values.map(item => item.text);
    hasContent = values.some(item => item.text || item.hasMedia);
  }
  if (question.kind === 'line') { answer.matches = entry.matches.map(item => item.options.find(option => option.value === item.element.value)?.option.id ?? ''); hasContent = answer.matches.some(Boolean); }
  if (question.kind === 'reader' || question.kind === 'fill') { answer.children = entry.children.map(child => ({ id: child.id, choices: child.choices.filter(choiceSelected).map(item => item.option.id) })); hasContent = answer.children.some(child => child.choices.length > 0); }
  const blocked = Boolean(entry.readOnly) || pageComplete(win.document) || disabled(entry.root) || !visible(entry.root) || !entry.root.isConnected
    || entry.choices.some(choice => disabled(choice.input ?? choice.element))
    || entry.texts.some(item => item.waiting || disabled(item.element) || Boolean(item.editor?.body && disabled(item.editor.body)))
    || entry.matches.some(item => disabled(item.element)) || entry.children.some(child => child.choices.some(choice => disabled(choice.input ?? choice.element)))
    || (question.kind === 'program' && (!entry.program || entry.program.waiting || entry.program.readOnly));
  const ready = question.supported && !blocked;
  const complete = question.kind === 'single' || question.kind === 'judgement' ? answer.choices?.length === 1
    : question.kind === 'multiple' ? Boolean(answer.choices?.length) : question.kind === 'completion' ? Boolean(answer.texts?.length && answer.texts.every(Boolean))
      : question.kind === 'line' ? Boolean(answer.matches?.length && answer.matches.every(Boolean))
        : question.kind === 'program' ? Boolean(programSaved) || Boolean(programCode && programCode !== programTemplate)
          : Boolean(answer.children?.length && answer.children.every(child => child.choices.length === 1));
  const content = JSON.stringify([answer, entry.texts.map(item => item.editor && !item.waiting ? item.editor.getContent() : item.element.value)]);
  // Version tracks the answer itself, not incidental DOM churn (CodeMirror cursor, scrollbars, run output).
  return { ready, version: signature(content), hasContent, complete, answer,
    ...(!ready ? { error: question.reason || '题目已完成、不可编辑或答题控件未就绪。' } : {}) };
}
