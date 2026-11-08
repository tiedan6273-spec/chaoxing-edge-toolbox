import type { AnswerPageCommand, AnswerPageResult, ApplicableAnswer, QuestionIdentity } from './types';
import { chapterAction, inspectQuestionPage, normalizeText, readQuestionControl, readSavedProgramCode, visible, type PageInspection, type QuestionEntry } from './adapters';
import { normalizeAnswer } from './normalize';
import { prepareQuestionImages } from './images';
import { prepareQuestionFont } from '../question-font';
import { captureQuestionSnapshotMarkdown } from '../question-extract/snapshot';
import { handlePaperFlow } from './flow-page';

const operations = new WeakMap<Document, AbortController>();

function locate(win: Window, identity: QuestionIdentity, readOnly = false): { inspection: PageInspection; entry: QuestionEntry } {
  const inspection = inspectQuestionPage(win);
  if (inspection.snapshot.documentKey !== identity.documentKey || inspection.snapshot.scopeKey !== identity.scopeKey) throw new Error('试卷或页面已变化，请重新扫描。');
  const matching = inspection.entries.filter(entry => entry.snapshot.key === identity.key && entry.snapshot.fingerprint === identity.fingerprint);
  if (matching.length !== 1 || (!readOnly && inspection.snapshot.complete)) throw new Error('题目已变化或已经完成，未处理旧题。');
  return { inspection, entry: matching[0] };
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('答题操作已取消。', 'AbortError');
}
function dispatch(win: Window, element: Element): void {
  const EventType = (win as Window & typeof globalThis).Event;
  element.dispatchEvent(new EventType('input', { bubbles: true }));
  element.dispatchEvent(new EventType('change', { bubbles: true }));
}
function plainTextHtml(value: string): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<p>${escaped.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')}</p>`;
}
function sameAnswer(left: ApplicableAnswer, right: ApplicableAnswer): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function saveProgram(win: Window, entry: QuestionEntry): boolean {
  const save = (win as Window & { saveQuestion?: (questionId: string, id: string) => void }).saveQuestion;
  if (typeof save === 'function') {
    try { save(entry.sourceId, entry.sourceId); return true; } catch { /* Fall back to the native save control. */ }
  }
  const button = entry.root.querySelector<HTMLElement>('.saveButtonClass, [onclick*="saveQuestion"]');
  if (!button) return false;
  try { button.click(); return true; } catch { return false; }
}
async function waitForProgramSaved(win: Window, entry: QuestionEntry, code: string, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    assertActive(signal);
    if (readSavedProgramCode(entry.root, entry.sourceId, entry.program?.languageId ?? '-1') === code) return true;
    await delay(win, signal);
  }
  return false;
}

async function write(win: Window, command: Extract<AnswerPageCommand, { action: 'write' }>, signal: AbortSignal): Promise<AnswerPageResult> {
  const { entry } = locate(win, command);
  let current = readQuestionControl(win, entry);
  if (!current.ready) throw new Error(current.error || '题目不可编辑。');
  if (current.version !== command.expectedVersion) throw new Error('答案已被修改，已保留你的编辑。');
  if (current.hasContent && !command.replace) throw new Error('题目已有答案，替换前需要明确授权。');
  const answer = normalizeAnswer(entry.snapshot, command.answer);
  if (!answer) throw new Error('答案无法完整且唯一地匹配当前题目，未执行填写。');
  function guard(): void {
    assertActive(signal);
    const live = locate(win, command).entry;
    const value = readQuestionControl(win, live);
    if (live.root !== entry.root || !value.ready || value.version !== current.version) throw new Error('题目或答案在填写期间变化，已停止后续填写。');
  }
  async function mutate(action: () => void, expected: ApplicableAnswer): Promise<void> {
    guard();
    action();
    // Framework-backed controls commit on the next turn. Pause can cancel here.
    await new Promise<void>(resolve => win.setTimeout(resolve, 0));
    assertActive(signal);
    const live = locate(win, command).entry;
    const value = readQuestionControl(win, live);
    if (live.root !== entry.root || !value.ready || !sameAnswer(value.answer, expected)) throw new Error('填写后的控件状态不一致，已停止；请检查页面上的部分填写结果。');
    current = value;
  }
  if (answer.choices) {
    const multiple = entry.snapshot.kind === 'multiple';
    for (const choice of entry.choices) {
      const selected = current.answer.choices?.includes(choice.option.id) ?? false;
      const wanted = answer.choices.includes(choice.option.id);
      if (selected === wanted || (!multiple && !wanted)) continue;
      const next = multiple ? entry.choices.filter(item => item.option.id === choice.option.id ? wanted : current.answer.choices?.includes(item.option.id)).map(item => item.option.id) : [choice.option.id];
      await mutate(() => choice.element.click(), { choices: next });
    }
  } else if (answer.texts) {
    for (let index = 0; index < entry.texts.length; index += 1) {
      const text = answer.texts[index];
      if (current.answer.texts?.[index] === normalizeText(text)) continue;
      const field = entry.texts[index];
      const next = [...current.answer.texts!]; next[index] = normalizeText(text);
      await mutate(() => {
        if (field.editor) {
          field.editor.fireEvent('savescene');
          field.editor.setContent(plainTextHtml(text), false);
          field.editor.sync?.();
          field.editor.fireEvent('contentchange');
          dispatch(win, field.editor.body!);
        } else {
          const constructors = win as Window & typeof globalThis;
          const prototype = field.element.tagName === 'TEXTAREA' ? constructors.HTMLTextAreaElement.prototype : constructors.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (!setter) throw new Error('文本控件不支持可靠写入。');
          setter.call(field.element, text);
          dispatch(win, field.element);
        }
      }, { texts: next });
    }
  } else if (answer.matches) {
    for (let index = 0; index < entry.matches.length; index += 1) {
      if (current.answer.matches?.[index] === answer.matches[index]) continue;
      const field = entry.matches[index];
      const option = field.options.find(item => item.option.id === answer.matches![index]);
      if (!option) throw new Error('连线答案不存在，已停止填写。');
      const next = [...current.answer.matches!]; next[index] = option.option.id;
      await mutate(() => {
        if (field.element.tagName === 'SELECT') {
          const prototype = (win as Window & typeof globalThis).HTMLSelectElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field.element, option.value);
          dispatch(win, field.element);
          const text = field.element.parentElement?.querySelector('.chosen-single span');
          if (text) text.textContent = option.option.text;
        } else option.element.click();
      }, { matches: next });
    }
  } else if (answer.children) {
    for (const child of entry.children) {
      const wanted = answer.children.find(item => item.id === child.id)!.choices[0];
      if (current.answer.children?.find(item => item.id === child.id)?.choices[0] === wanted) continue;
      const choice = child.choices.find(item => item.option.id === wanted)!;
      const next = current.answer.children!.map(item => item.id === child.id ? { id: child.id, choices: [wanted] } : item);
      await mutate(() => choice.element.click(), { children: next });
    }
  } else if (answer.code !== undefined) {
    const code = answer.code;
    const editor = entry.program?.editor;
    if (!editor) throw new Error('编程编辑器未就绪，未写入代码。');
    if (code === entry.program?.template) throw new Error('生成的代码与页面初始模板相同，未写入；请重试本题。');
    await mutate(() => editor.setValue(code), { code });
  }
  guard();
  if (!sameAnswer(current.answer, answer) || !current.complete) throw new Error('答案回读不一致，未将该题标记为已填写。');
  let warning: string | undefined;
  if (entry.snapshot.kind === 'program') {
    if (!saveProgram(win, entry)) warning = '未找到页面保存入口；请手动点击题目下方的“保存”后核对。';
    else if (!(await waitForProgramSaved(win, entry, answer.code ?? '', signal))) warning = '未确认平台保存；请点击题目下方的“保存”后核对。';
  }
  return { ok: true, control: current, ...(warning ? { warning } : {}) };
}

function delay(win: Window, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    assertActive(signal);
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timeout = win.setTimeout(done, 100);
    const cancel = () => { win.clearTimeout(timeout); reject(new DOMException('答题操作已取消。', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
function successMessages(win: Window): Map<Element, string> {
  return new Map(Array.from(win.document.querySelectorAll('.testTit_status,.layui-layer-content,.ui-dialog-content,[role=status],[role=alert]'))
    .filter(visible).map(node => [node, normalizeText(node.textContent ?? '')]));
}
function sameOriginParent(win: Window): Window | undefined {
  try {
    const parent = win.parent;
    if (!parent || parent === win) return undefined;
    // Reading the document is the only portable same-origin probe.
    return parent.document ? parent : undefined;
  } catch { return undefined; }
}
function shellDocuments(win: Window): Document[] {
  const documents = [win.document];
  let current = win;
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = sameOriginParent(current);
    if (!parent) break;
    documents.push(parent.document);
    current = parent;
  }
  return documents;
}
/** chaoxing draws its submit confirmation in the study shell, not in the quiz frame that owns the paper. */
function shellSubmitConfirmation(win: Window): HTMLElement | undefined {
  for (const doc of shellDocuments(win)) {
    const prompt = doc.querySelector<HTMLElement>('#workpop');
    if (!prompt || !visible(prompt)) continue;
    const button = prompt.querySelector<HTMLElement>('#popok');
    if (!button || !visible(button) || !/确认提交/.test(normalizeText(prompt.querySelector('#popcontent')?.textContent ?? ''))
      || !/^(?:提交|确定|确认)$/.test(normalizeText(button.textContent ?? ''))) continue;
    return button;
  }
  return undefined;
}

async function finish(win: Window, command: Extract<AnswerPageCommand, { action: 'finish' }>, signal: AbortSignal): Promise<AnswerPageResult> {
  function validate(allowSubmitted = false): PageInspection {
    assertActive(signal);
    const inspection = inspectQuestionPage(win);
    const page = inspection.snapshot;
    if (page.documentKey !== command.documentKey || page.scopeKey !== command.scopeKey || page.scene !== 'chapter-test' || (page.complete && !allowSubmitted)) throw new Error('章节测验已变化或完成，未执行保存或提交。');
    if (command.expected.length !== inspection.entries.length || !command.expected.length || new Set(command.expected.map(item => item.key)).size !== command.expected.length) throw new Error('题目清单不一致，未执行保存或提交。');
    for (const entry of inspection.entries) {
      const expected = command.expected.find(item => item.key === entry.snapshot.key);
      const state = readQuestionControl(win, entry);
      if (!expected || entry.snapshot.fingerprint !== expected.fingerprint || state.version !== expected.version) throw new Error('题目或答案已变化，未执行保存或提交。');
      if (command.policy === 'submit' && ((!state.ready && !page.complete) || !state.complete)) throw new Error('仍有未完成或不支持的题目，未提交。');
    }
    if (command.policy === 'submit' && !page.allLoaded) throw new Error('无法确认整份测验已加载，未提交。');
    return inspection;
  }
  const initial = validate();
  if (!(command.policy === 'save' ? initial.snapshot.canSave : initial.snapshot.canSubmit)) throw new Error('当前页面没有已核对的原生保存／提交入口，请手动处理。');
  if (command.policy === 'submit' && chapterAction(win, 'confirm')) throw new Error('页面已有提交确认，请先手动处理。');
  const action = chapterAction(win, command.policy)!;
  const baseline = successMessages(win);
  const deadline = Date.now() + 6000;
  let confirmed = false;
  validate();
  action.click();
  while (Date.now() < deadline) {
    assertActive(signal);
    const live = validate(command.policy === 'submit');
    if (command.policy === 'submit' && live.snapshot.complete) return { ok: true, outcome: 'submitted' };
    for (const [element, text] of successMessages(win)) {
      if (baseline.get(element) === text) continue;
      if (command.policy === 'save' && /^(?:答案)?(?:保存成功|已保存)[！!。]?$/.test(text)) return { ok: true, outcome: 'saved' };
      if (command.policy === 'submit' && /^(?:试卷|测验|答案)?提交成功[！!。]?$/.test(text)) return { ok: true, outcome: 'submitted' };
    }
    if (command.policy === 'submit' && !confirmed) {
      const confirm = chapterAction(win, 'confirm') ?? shellSubmitConfirmation(win);
      if (confirm) { validate(); confirmed = true; confirm.click(); }
    }
    await delay(win, signal);
  }
  throw new Error('未收到明确的保存／提交成功反馈，已暂停；请在页面核对结果后继续。');
}

/** MAIN-world dispatcher. Secrets and external answer requests never enter this module. */
export async function handleAnswerPageCommand(win: Window, command: AnswerPageCommand): Promise<AnswerPageResult> {
  if (command.action === 'cancel') { operations.get(win.document)?.abort(); operations.delete(win.document); return { ok: true }; }
  try {
    if (command.action === 'inspect') {
      await prepareQuestionFont(win.document);
      const inspection = inspectQuestionPage(win);
      for (const entry of inspection.entries) {
        // Copy formatting is optional and cannot block the structured answer snapshot.
        try { entry.snapshot.markdown = captureQuestionSnapshotMarkdown(entry.snapshot, entry.root); }
        catch { /* Legacy structured snapshots remain fully usable for preview and answering. */ }
      }
      return { ok: true, snapshot: inspection.snapshot };
    }
    if (command.action === 'read') {
      const { entry } = locate(win, command, true);
      return { ok: true, control: readQuestionControl(win, entry) };
    }
    if (operations.has(win.document)) throw new Error('当前题目页面仍有操作进行中，请先停止。');
    const abort = new AbortController();
    operations.set(win.document, abort);
    try {
      if (command.action === 'flow') return await handlePaperFlow(win, command, abort.signal, () => inspectQuestionPage(win));
      if (command.action === 'write') return await write(win, command, abort.signal);
      if (command.action === 'finish') return await finish(win, command, abort.signal);
      const { entry } = locate(win, command, true);
      const before = readQuestionControl(win, entry);
      if (!entry.snapshot.supported) throw new Error(entry.snapshot.reason || '当前题目不可读取。');
      const timeout = win.setTimeout(() => abort.abort(), 15000);
      try {
        const prepared = await prepareQuestionImages(win, entry.root, entry.snapshot, abort.signal);
        prepared.question = { ...prepared.question }; delete prepared.question.reviewData;
        assertActive(abort.signal);
        const after = locate(win, command, true).entry;
        if (after.root !== entry.root || readQuestionControl(win, after).version !== before.version) throw new Error('图片读取期间题目或答案已变化，请重试。');
        return { ok: true, prepared };
      } finally { win.clearTimeout(timeout); }
    } finally { if (operations.get(win.document) === abort) operations.delete(win.document); }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '题目页面操作失败，请重新扫描。' };
  }
}
