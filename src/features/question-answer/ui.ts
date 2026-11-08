import type { SettingsSection } from '../../platform/settings-navigation';
import { isFeatureEnabled, type Settings } from '../toolbox-settings/types';
import type { WorkspaceView } from '../workspace-registry';
import type { AnswerRow, AnswerSource, QuestionAnswerController, QuestionAnswerState, QuestionKind, QuestionSnapshot } from './types';
import { answerSourceNotice } from './source-status';
import { formatQuestionSnapshot, formatQuestionSnapshots } from '../question-extract/snapshot';
import { canPreviewQuestions } from './permissions';
import { createQuestionImages } from './question-images';
import { createAnswerExchangeView } from '../answer-exchange/ui';
import { isCompleteApplicableAnswer, answerDifference } from './review';
import { formatApplicableAnswer } from './answer-format';
import { createResultsExportView } from './export-ui';
import { createLocalBankPicker } from '../local-question-bank/picker-ui';
import { hasAnswerContent } from './export';
import { createUsageView } from '../activity/ui';
import { createDiagnosticView } from '../activity/diagnostics';
import { createSavedActions } from '../saved-questions/ui';
import { createSimilarView } from '../local-question-bank/similar-ui';
import { createPaperFlowView } from './flow-controller';

interface QuestionAnswerViewDependencies {
  answer: QuestionAnswerController;
  openSettings(section?: SettingsSection): Promise<void>;
  title?: string;
  embedded?: boolean;
  showRunActions?(): boolean;
  canRun?(): boolean;
}

interface AnswerRowView {
  element: HTMLLIElement; title: HTMLElement; phase: HTMLElement; stem: HTMLElement; message: HTMLElement;
  source: HTMLElement; tags: HTMLElement; preview: HTMLDetailsElement; text: HTMLElement; content: HTMLElement; current: HTMLElement; currentBlock: HTMLElement; contentKey: string; resultMode?: string;
  review: HTMLElement; reviewHeading: HTMLElement; reviewSuggestionBlock: HTMLElement; reviewSuggestion: HTMLElement; reviewReason: HTMLElement;
  retry: HTMLButtonElement; replace: HTMLButtonElement; confirm: HTMLElement; confirmButton: HTMLButtonElement;
  search: HTMLButtonElement; apply: HTMLButtonElement; reference: HTMLElement; referenceBlock: HTMLElement; platformReview: HTMLElement;
}

const phaseLabels: Record<QuestionAnswerState['phase'], string> = {
  idle: '等待开始', scanning: '识别题目', running: '答题中', paused: '已暂停', complete: '处理结束', error: '需要处理',
};
const rowLabels: Record<AnswerRow['phase'], string> = {
  pending: '等待处理', querying: '获取答案', searched: '已获取 · 未填写', filled: '已填写', existing: '保留已有内容', unsupported: '暂不支持', error: '处理失败', 'needs-review': '需要检查',
};
const sourceLabels: Record<AnswerSource, string> = { bank: '言溪题库', 'bank-ai': '言溪 AI', ai: 'AI', import: '外部 AI 导入', 'local-bank': '本地题库' };
const kindLabels: Record<QuestionKind, string> = {
  single: '单选', multiple: '多选', judgement: '判断', completion: '文本填写', line: '连线 / 匹配', fill: '完形填空', reader: '阅读理解', program: '程序题', unsupported: '未知题型',
};

function rowPhaseLabel(row: AnswerRow): string {
  return row.phase === 'unsupported' && /字体|字形|加密文字|加密文本|加密字符|字符映射|字符索引|font-cxsecret/i.test(`${row.message} ${row.target.question.reason ?? ''}`)
    ? '文字待识别' : rowLabels[row.phase];
}

function isRoutineMessage(message: string): boolean {
  return message === '正在读取当前页面各题目框架…' || message === '正在逐题获取并填写答案；可随时暂停。'
    || /^已读取当前加载的 \d+ 题，可先阅览再开始答题。$/.test(message);
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function button(text: string, action: string, primary = false): HTMLButtonElement {
  const element = createElement('button', primary ? 'button primary' : 'button', text);
  element.type = 'button';
  element.dataset.answerAction = action;
  return element;
}

/** Keep controls and keyed result rows mounted while the shared queue progresses. */
export function createQuestionAnswerView(dependencies: QuestionAnswerViewDependencies): WorkspaceView {
  const listeners = new AbortController();
  const { signal } = listeners;
  const root = createElement('section', 'feature-view question-answer-view');
  root.setAttribute('aria-label', dependencies.title || '题库与 AI 答题');
  const heading = createElement('div', 'answer-heading');
  heading.hidden = Boolean(dependencies.embedded);
  const phase = createElement('span', 'phase-badge');
  heading.append(createElement('h3', 'section-title', dependencies.title || '题目与答案'), phase);
  const configuration = createElement('details', 'answer-configuration');
  const configurationSummary = createElement('summary', '', '答题设置');
  const configurationContent = createElement('div', 'answer-configuration-content');
  const controls = createElement('div', 'answer-source-settings');
  const sourceLabel = createElement('label', 'answer-source-label', '答案来源');
  const source = createElement('select');
  source.setAttribute('aria-label', '答案来源');
  for (const [value, text] of [['', '请选择答题来源'], ['local', '仅本地题库'], ['prefer-bank', '言溪优先，AI 补充'], ['bank', '仅言溪'], ['ai', '仅 AI']]) {
    const option = createElement('option', '', text);
    option.value = value;
    option.disabled = !value;
    source.append(option);
  }
  sourceLabel.append(source);
  const settingsButtons = createElement('div', 'answer-settings-actions');
  const bankSettings = button('言溪设置', 'bank-settings');
  const aiSettings = button('AI 设置', 'ai-settings');
  settingsButtons.append(bankSettings, aiSettings);
  controls.append(sourceLabel, settingsButtons);
  const sourceStatus = createElement('p', 'answer-config-status');
  sourceStatus.setAttribute('role', 'status');
  sourceStatus.setAttribute('aria-live', 'polite');
  const recheck = button('重新检查', 'refresh-sources');
  settingsButtons.append(recheck);
  const message = createElement('p', 'answer-message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.setAttribute('aria-atomic', 'true');
  const progressLine = createElement('div', 'answer-progress-line');
  const progress = createElement('p', 'answer-progress');
  const actions = createElement('div', 'answer-actions');
  const start = button('开始答题', 'start', true);
  const stop = button('暂停处理', 'stop', true);
  const featureSettings = button('功能设置', 'feature-settings');
  const inspect = button('阅览题目', 'preview');
  const follow = button('跟随进度', 'follow-progress');
  follow.title = '回到当前正在处理的题目，并跟随后续答题进度';
  actions.append(inspect, start, stop);
  settingsButtons.append(featureSettings);
  progressLine.append(progress, follow, actions);
  const rows = createElement('ol', 'answer-results');
  rows.setAttribute('aria-label', '逐题答题结果');
  const paperStatus = createElement('p', 'answer-paper-status');
  const grid = createElement('nav', 'answer-question-grid');
  grid.setAttribute('aria-label', '整卷题号阅览');
  const completion = createElement('p', 'answer-completion-status');
  completion.setAttribute('role', 'status');
  const boundary = createElement('p', 'editor-hint answer-boundary', '仅处理当前已加载题目；已有答案默认保留。暂停只影响插件，考试计时仍继续。独立作业和考试填写后停留，请自行检查并保存或交卷。');
  const copyActions = createElement('div', 'answer-copy-actions');
  const copyCurrent = button('复制本题', 'copy-question');
  const copyAll = button('复制当前全部', 'copy-all');
  copyCurrent.title = '复制当前阅览题目的 Markdown，保留图片链接';
  copyAll.title = '按题号顺序复制当前已加载题目，不包含答案';
  copyActions.append(copyCurrent, copyAll);
  const copyStatus = createElement('p', 'answer-copy-status');
  copyStatus.setAttribute('role', 'status');
  const copyFallback = createElement('textarea', 'answer-copy-fallback');
  copyFallback.readOnly = true;
  copyFallback.setAttribute('aria-label', '待复制的题目 Markdown');
  copyFallback.hidden = true;
  const localBank = createLocalBankPicker(() => { void dependencies.openSettings('question-bank'); });
  configurationContent.append(controls, localBank.element, sourceStatus, boundary);
  configuration.append(configurationSummary, configurationContent);
  const exchange = createAnswerExchangeView({ controller: dependencies.answer });
  const resultExport = createResultsExportView({ getState: () => dependencies.answer.getState() });
  const history = createElement('details', 'answer-configuration answer-history');
  history.append(createElement('summary', '', '本机搜题记录'));
  const historyBody = createElement('div', 'answer-configuration-content');
  const historyMessage = createElement('p'); historyMessage.setAttribute('role', 'status');
  const restoreHistory = button('恢复匹配记录', 'restore-history');
  const clearHistory = button('删除本页历史', 'clear-history');
  const confirmHistory = button('确认删除本页历史', 'confirm-clear-history'); confirmHistory.hidden = true;
  historyBody.append(historyMessage, restoreHistory, clearHistory, confirmHistory); history.append(historyBody);
  const usage = createUsageView(() => { void dependencies.openSettings('api'); });
  const diagnostic = createDiagnosticView({ recheck: () => dependencies.answer.preview?.(), settings: () => { void dependencies.openSettings('api'); } });
  const operationControls = createElement('div', 'answer-operation-controls');
  const modeLabel = createElement('label', '', '处理模式');
  const mode = createElement('select'); mode.setAttribute('aria-label', '处理模式');
  for (const [value, text] of [['search', '只搜题'], ['fill', '自动填写']]) { const option = createElement('option', '', text); option.value = value; mode.append(option); }
  modeLabel.append(mode);
  const rangeLabel = createElement('label', '', '处理范围');
  const range = createElement('select'); range.setAttribute('aria-label', '处理范围');
  for (const [value, text] of [['all', '当前已加载全部题'], ['current', '仅本题'], ['forward', '当前题及后续']]) { const option = createElement('option', '', text); option.value = value; range.append(option); }
  rangeLabel.append(range);
  const anchor = createElement('p', 'editor-hint answer-range-anchor');
  operationControls.append(modeLabel, rangeLabel, anchor);
  const reviewActions = createElement('div', 'answer-review-actions');
  const reviewButton = button('AI 整卷复检', 'review', true);
  const reviewStop = button('停止复检', 'review-stop');
  const reviewAgain = button('重新请求 AI', 'review-again');
  const reviewConfirm = createElement('div', 'answer-replace-confirm');
  reviewConfirm.hidden = true;
  reviewConfirm.append(createElement('p', '', '将重新发送整卷并产生一次新的 AI 用量。'));
  const confirmReview = button('确认重新复检', 'review-confirm');
  const cancelReview = button('取消', 'review-cancel');
  reviewConfirm.append(confirmReview, cancelReview);
  const differences = createElement('div', 'answer-difference-summary');
  const differenceText = createElement('span');
  const nextDifference = button('定位不一致题', 'next-difference');
  differences.append(differenceText, nextDifference);
  const reviewStatus = createElement('p', 'answer-review-status');
  reviewStatus.setAttribute('role', 'status');
  reviewStatus.setAttribute('aria-live', 'polite');
  reviewActions.append(reviewButton, reviewStop, reviewAgain, reviewConfirm, reviewStatus);
  root.append(heading, operationControls, configuration, message, diagnostic.element, progressLine, completion, paperStatus, differences, grid, rows, history, usage.element, copyActions, resultExport.element, copyStatus, copyFallback, reviewActions, exchange.element);
  const flowView = dependencies.answer.flow ? createPaperFlowView(dependencies.answer.flow) : undefined;
  if (flowView) root.insertBefore(flowView.element, history);

  let settings: Settings | undefined;
  let saving = false;
  let state = dependencies.answer.getState();
  let localError = '';
  let disposed = false;
  let confirmingId = '';
  let confirmingRevision = '';
  let confirmingApply = false;
  const rowViews = new Map<string, AnswerRowView>();
  const numberViews = new Map<string, HTMLButtonElement>();
  let localSelectedId = '';
  let sourcesWereReady: boolean | undefined;
  let copying = false;
  let copyRevision = 0;
  let paperIdentity = '';

  function clearConfirmation(): void { confirmingId = ''; confirmingRevision = ''; confirmingApply = false; }
  function canAct(): boolean { return Boolean(settings && isFeatureEnabled(settings, 'question-answer') && !saving && !state.running && !state.sourceSaving && !state.history?.busy); }
  function canAnswer(): boolean {
    return canAct() && dependencies.canRun?.() !== false && !state.previewStale
      && state.rows.some(row => row.target.question.supported && !row.readOnly) && Boolean(answerSourceNotice(state).first);
  }
  function canSearch(): boolean { return canAct() && dependencies.canRun?.() !== false && !state.previewStale && !state.previewing
    && state.rows.some(row => row.target.question.supported) && Boolean(answerSourceNotice(state).first); }
  function canStart(): boolean { return state.mode === 'search' ? canSearch() : canAnswer(); }
  function currentRow(id: string): AnswerRow | undefined { return state.rows.find(row => row.id === id); }
  function selectedRow(): AnswerRow | undefined { return currentRow(state.selectedId ?? '') ?? currentRow(localSelectedId) ?? state.rows[0]; }
  function canCopy(): boolean {
    return Boolean(settings && isFeatureEnabled(settings, 'question-extract') && !saving && !copying && !state.previewing && !state.previewStale && state.rows.length);
  }
  function clearCopy(): void {
    ++copyRevision;
    copying = false;
    copyStatus.textContent = '';
    copyFallback.hidden = true;
    copyFallback.value = '';
  }
  async function copyQuestions(all: boolean): Promise<void> {
    const row = selectedRow();
    if (!canCopy() || !row) return;
    const text = all ? formatQuestionSnapshots(state.rows.map(value => value.target.question)) : formatQuestionSnapshot(row.target.question);
    const label = all ? `当前 ${state.rows.length} 题` : `第 ${row.target.question.number} 题`;
    const revision = ++copyRevision;
    copying = true;
    copyFallback.hidden = true;
    copyFallback.value = '';
    copyStatus.textContent = '正在复制…';
    render();
    try {
      await navigator.clipboard.writeText(text);
      if (!disposed && revision === copyRevision) copyStatus.textContent = `已复制${label}。`;
    } catch {
      if (!disposed && revision === copyRevision) {
        copyStatus.textContent = `无法自动复制${label}，请按 Ctrl+C 复制下方已选内容。`;
        copyFallback.value = text;
        copyFallback.hidden = false;
        copyFallback.focus();
        copyFallback.select();
      }
    } finally {
      if (!disposed && revision === copyRevision) { copying = false; render(); }
    }
  }
  function revision(row: AnswerRow): string {
    return JSON.stringify([row.target.frameId, row.target.documentId, row.target.documentKey, row.target.scopeKey,
      row.target.question.key, row.target.question.fingerprint, row.phase, row.text, row.message, row.currentAnswer, row.readOnly, row.resultAnswer, row.resultApplicable]);
  }

  function createRow(id: string): AnswerRowView {
    const element = createElement('li', 'answer-result');
    element.dataset.answerRow = id;
    const header = createElement('div', 'answer-result-heading');
    const title = createElement('span', 'answer-result-title');
    const rowPhase = createElement('span', 'phase-badge');
    header.append(title, rowPhase);
    const stem = createElement('p', 'answer-result-stem');
    const content = createElement('div', 'answer-question-content');
    const rowMessage = createElement('p', 'answer-result-message');
    const metadata = createElement('div', 'answer-result-meta');
    const answerSource = createElement('span', 'answer-result-source');
    const tags = createElement('span', 'answer-result-tags');
    metadata.append(answerSource, tags);
    const preview = createElement('details', 'answer-result-preview');
    const text = createElement('pre');
    preview.append(createElement('summary', '', '生成答案'), text);
    const currentBlock = createElement('div', 'answer-current');
    const current = createElement('pre');
    currentBlock.append(createElement('span', 'answer-answer-label', '当前页面答案'), current);
    const referenceBlock = createElement('div', 'answer-reference'); const reference = createElement('pre');
    referenceBlock.append(createElement('span', 'answer-answer-label', '获取的参考答案'), reference);
    const platformReview = createElement('div', 'answer-platform-review');
    const review = createElement('div', 'answer-review');
    const reviewHeading = createElement('p', 'answer-review-heading');
    const reviewSuggestionBlock = createElement('div', 'answer-review-suggestion');
    const reviewSuggestion = createElement('pre');
    reviewSuggestionBlock.append(createElement('span', 'answer-answer-label', 'AI 建议答案'), reviewSuggestion);
    const reviewReason = createElement('p', 'answer-review-reason');
    review.append(reviewHeading, reviewSuggestionBlock, reviewReason);
    const rowActions = createElement('div', 'answer-result-actions');
    const retry = button('重试本题', 'retry');
    const replace = button('重新生成并覆盖', 'replace');
    const search = button('搜本题', 'search'); const apply = button('应用本题答案', 'apply');
    rowActions.append(search, apply, retry, replace);
    rowActions.append(createSavedActions(() => {
      const row = currentRow(id); if (!row) return undefined;
      return { question: row.target.question, currentAnswer: row.currentAnswer, referenceAnswer: row.resultAnswer,
        source: row.source ?? '页面题目', course: '', wrong: false, tags: [], note: row.target.question.reviewData?.explanation ?? '' };
    }));
    const confirm = createElement('div', 'answer-replace-confirm');
    confirm.setAttribute('role', 'group');
    confirm.setAttribute('aria-label', '确认覆盖本题已有答案');
    const confirmButton = button('确认覆盖本题', 'confirm-replace');
    const cancelButton = button('取消', 'cancel-replace');
    confirm.append(createElement('p', '', '将重新获取答案并覆盖本题已有内容。'), confirmButton, cancelButton);
    element.append(header, stem, content, currentBlock, referenceBlock, platformReview, review, rowMessage, metadata, preview, rowActions, confirm);
    element.append(createSimilarView(() => currentRow(id)?.target.question));
    search.addEventListener('click', () => {
      if (!canSearch()) return; clearConfirmation(); localError = ''; dependencies.answer.search?.(id);
    }, { signal });
    apply.addEventListener('click', () => {
      const row = currentRow(id);
      if (!canAnswer() || !row || row.readOnly || !row.resultApplicable) return;
      if (!hasAnswerContent(row.currentAnswer)) { dependencies.answer.applyResult?.(id); return; }
      confirmingApply = true; confirmingId = id; confirmingRevision = revision(row);
      confirm.querySelector('p')!.textContent = '将使用已获取的参考答案覆盖本题已有内容。'; render(); confirmButton.focus();
    }, { signal });
    retry.addEventListener('click', () => {
      const row = currentRow(id);
      if (!canAnswer() || !row || row.readOnly) return;
      clearConfirmation();
      localError = '';
      dependencies.answer.retry(id);
    }, { signal });
    replace.addEventListener('click', () => {
      const row = currentRow(id);
      if (!canAnswer() || !row || row.readOnly) return;
      confirmingId = id;
      confirmingApply = false;
      confirm.querySelector('p')!.textContent = '将重新获取答案并覆盖本题已有内容。';
      confirmingRevision = revision(row);
      render();
      confirmButton.focus();
    }, { signal });
    cancelButton.addEventListener('click', () => { clearConfirmation(); render(); replace.focus(); }, { signal });
    confirmButton.addEventListener('click', () => {
      const row = currentRow(id);
      if (!canAnswer() || !row || row.readOnly || confirmingId !== id || confirmingRevision !== revision(row)) return;
      const applyExisting = confirmingApply; clearConfirmation();
      localError = '';
      if (applyExisting) dependencies.answer.applyResult?.(id, true); else dependencies.answer.retry(id, true);
      render();
    }, { signal });
    return {
      element, title, phase: rowPhase, stem, message: rowMessage, source: answerSource, tags, preview, text, content,
      current, currentBlock, contentKey: '', review, reviewHeading, reviewSuggestionBlock, reviewSuggestion, reviewReason,
      retry, replace, confirm, confirmButton, search, apply, reference, referenceBlock, platformReview,
    };
  }

  function renderQuestionContent(view: AnswerRowView, question: QuestionSnapshot): void {
    const key = JSON.stringify([question.fingerprint, question.options, question.fields, question.children, question.images, question.markdown]);
    if (view.contentKey === key) return;
    view.contentKey = key;
    view.content.replaceChildren();
    if (question.program) view.content.append(createElement('p', 'answer-program-language', `编程语言：${question.program.language}`));
    function appendOptions(options: QuestionSnapshot['options'], parent: HTMLElement): void {
      if (!options.length) return;
      const list = createElement('ul', 'answer-options');
      for (const option of options) list.append(createElement('li', '', `${option.label} · ${option.text}`));
      parent.append(list);
    }
    appendOptions(question.options, view.content);
    question.fields.forEach((field, index) => {
      const slot = createElement('div', 'answer-field');
      slot.append(createElement('p', '', `${question.kind === 'line' ? '匹配项' : '填写位置'} ${index + 1}`));
      appendOptions(field.options ?? [], slot);
      view.content.append(slot);
    });
    question.children.forEach((child, index) => {
      const section = createElement('section', 'answer-child');
      section.append(createElement('p', '', `子题 ${index + 1} · ${child.stem}`));
      appendOptions(child.options, section);
      view.content.append(section);
    });
    const images = createQuestionImages(question);
    if (images) view.content.append(images);
  }

  function renderRows(): void {
    const currentIds = new Set(state.rows.map(row => row.id));
    for (const [id, view] of rowViews) {
      if (!currentIds.has(id)) { view.element.remove(); rowViews.delete(id); }
    }
    for (const [id, number] of numberViews) {
      if (!currentIds.has(id)) { number.remove(); numberViews.delete(id); }
    }
    const selectedId = selectedRow()?.id;
    let previous: HTMLElement | null = null;
    let previousNumber: HTMLElement | null = null;
    for (const row of state.rows) {
      let number = numberViews.get(row.id);
      if (!number) {
        number = button(row.target.question.number, 'select-question');
        number.dataset.answerQuestion = row.id;
        number.addEventListener('click', () => {
          localSelectedId = row.id;
          clearConfirmation();
          dependencies.answer.selectQuestion?.(row.id);
          render();
        }, { signal });
        numberViews.set(row.id, number);
      }
      const nextNumber: Element | null = previousNumber ? previousNumber.nextElementSibling : grid.firstElementChild;
      if (nextNumber !== number) grid.insertBefore(number, nextNumber);
      previousNumber = number;
      number.textContent = row.target.question.number.replace(/^(单选|多选|判断)\s+(\d+)$/, (_all, kind: string, value: string) => `${kind[0]}${value}`);
      number.dataset.phase = row.phase;
      const rowLabel = rowPhaseLabel(row);
      const difference = answerDifference(row);
      const reviewLabel = difference?.status === 'suspect' ? '答案不一致 · 请核对'
        : difference?.status === 'uncertain' ? 'AI 需人工确认' : '';
      if (difference) number.dataset.review = difference.status;
      else delete number.dataset.review;
      number.setAttribute('aria-pressed', String(row.id === selectedId));
      number.setAttribute('aria-label', `第 ${row.target.question.number} 题，${rowLabel}${reviewLabel ? `，${reviewLabel}` : ''}`);
      number.title = `第 ${row.target.question.number} 题 · ${rowLabel}${reviewLabel ? ` · ${reviewLabel}` : ''}`;
      let view = rowViews.get(row.id);
      if (!view) { view = createRow(row.id); rowViews.set(row.id, view); }
      const before: Element | null = previous ? previous.nextElementSibling : rows.firstElementChild;
      if (before !== view.element) rows.insertBefore(view.element, before);
      previous = view.element;
      view.element.hidden = row.id !== selectedId;
      const currentRevision = revision(row);
      if (confirmingId === row.id && (confirmingRevision !== currentRevision || !canAnswer())) clearConfirmation();
      view.title.textContent = `第 ${row.target.question.number} 题 · ${kindLabels[row.target.question.kind]}`;
      view.phase.textContent = rowLabel;
      view.phase.dataset.phase = row.phase;
      view.stem.textContent = row.target.question.stem;
      renderQuestionContent(view, row.target.question);
      view.current.textContent = formatApplicableAnswer(row.target.question, row.currentAnswer);
      view.referenceBlock.hidden = !row.resultAnswer;
      view.reference.textContent = row.resultAnswer ? formatApplicableAnswer(row.target.question, row.resultAnswer) : '';
      view.referenceBlock.querySelector('.answer-answer-label')!.textContent = row.resultApplicable === false ? '获取的参考答案（已失效，需重新搜题）' : '获取的参考答案';
      const platformData = row.target.question.reviewData;
      view.platformReview.hidden = !platformData;
      view.platformReview.textContent = platformData ? `平台回看 · 我的答案：${formatApplicableAnswer(row.target.question, platformData.answer)}\n得分：${platformData.score || '未提供'} / ${platformData.maxScore || '未提供'}\n解析：${platformData.explanation || '未提供'}\n我的答案不等同于标准答案。` : '';
      const currentLabel = view.currentBlock.querySelector('.answer-answer-label');
      if (currentLabel) currentLabel.textContent = row.target.question.kind === 'program' ? '当前页面代码' : '当前页面答案';
      const suggestionLabel = view.reviewSuggestionBlock.querySelector('.answer-answer-label');
      if (suggestionLabel) suggestionLabel.textContent = row.target.question.kind === 'program' ? 'AI 建议代码' : 'AI 建议答案';
      if (row.target.question.kind === 'program') { view.current.dataset.code = 'true'; view.reviewSuggestion.dataset.code = 'true'; }
      else { delete view.current.dataset.code; delete view.reviewSuggestion.dataset.code; }
      if (difference) {
        view.element.dataset.review = difference.status;
        view.review.hidden = false;
        view.reviewHeading.textContent = reviewLabel;
        view.reviewSuggestionBlock.hidden = difference.status !== 'suspect';
        view.reviewSuggestion.textContent = difference.suggestedAnswer ? formatApplicableAnswer(row.target.question, difference.suggestedAnswer) : '';
        view.reviewReason.textContent = difference.reason;
      } else {
        delete view.element.dataset.review;
        view.review.hidden = true;
        view.reviewSuggestion.textContent = '';
        view.reviewReason.textContent = '';
      }
      const hasCurrent = Boolean(row.currentAnswer && (row.currentAnswer.code?.trim()
        || [row.currentAnswer.choices, row.currentAnswer.texts, row.currentAnswer.matches,
          row.currentAnswer.children?.flatMap(child => child.choices)].some(values => values?.some(value => value.trim()))));
      const resultMode = row.phase === 'querying' || (row.text && !hasCurrent && row.phase !== 'filled') ? 'generated' : 'current';
      view.currentBlock.hidden = resultMode === 'generated' && !hasCurrent;
      view.preview.querySelector('summary')!.textContent = resultMode === 'generated' ? '生成答案' : '详细结果 · 生成原文';
      if (view.resultMode !== resultMode) { view.preview.open = resultMode === 'generated'; view.resultMode = resultMode; }
      const recognition = row.target.question.textRecognition;
      const recognitionNotice = recognition ? recognition.status === 'pending' ? '文字仍在识别，请稍候重新读取。'
        : `含 ${recognition.unresolvedCount} 字未识别，AI 仅参考现有内容作答，请核对结果。` : '';
      view.message.textContent = [recognitionNotice, row.message].filter(Boolean).join(' ');
      view.message.hidden = !recognitionNotice && (!row.message || /^(?:等待处理|尚未填写。|正在获取答案…|已填写并核对。|保留页面已有答案。|保留已有答案。)$/.test(row.message));
      view.source.textContent = row.source ? `来源：${sourceLabels[row.source]}` : '';
      view.source.hidden = !row.source;
      view.tags.textContent = row.tags?.map(tag => tag.text).join(' · ') ?? '';
      view.tags.title = row.tags?.map(tag => tag.title || tag.text).join('；') ?? '';
      view.tags.hidden = !view.tags.textContent;
      view.preview.hidden = !row.text && row.phase !== 'querying';
      view.text.textContent = row.text || (row.phase === 'querying' ? '正在获取答案…' : '');
      view.search.hidden = !dependencies.answer.search || !settings || !isFeatureEnabled(settings, 'question-answer');
      view.search.textContent = row.resultAnswer ? '重新搜本题' : '搜本题'; view.search.disabled = !canSearch() || !row.target.question.supported;
      view.apply.hidden = !dependencies.answer.applyResult || !row.resultAnswer || Boolean(row.readOnly);
      view.apply.disabled = !canAnswer() || !row.resultApplicable;
      view.retry.hidden = state.mode === 'search' || !settings || !isFeatureEnabled(settings, 'question-answer') || Boolean(row.readOnly) || ['pending', 'querying', 'unsupported', 'searched'].includes(row.phase);
      view.retry.disabled = !canAnswer();
      view.replace.hidden = state.mode === 'search' || !settings || !isFeatureEnabled(settings, 'question-answer') || Boolean(row.readOnly) || !['existing', 'filled', 'needs-review'].includes(row.phase);
      view.replace.disabled = !canAnswer();
      view.confirm.hidden = confirmingId !== row.id;
      view.confirmButton.disabled = !canAnswer();
    }
  }

  function render(): void {
    if (disposed) return;
    const enabled = Boolean(settings && isFeatureEnabled(settings, 'question-answer'));
    const previewEnabled = canPreviewQuestions(settings);
    history.hidden = !dependencies.answer.restoreHistory || !previewEnabled;
    historyMessage.textContent = state.history?.busy ? state.history.message : `${state.history?.available ? `有 ${state.history.available} 题匹配记录。` : ''}${state.history?.message || '识别题目后检查可恢复记录。'}`;
    restoreHistory.disabled = !canAct() || Boolean(state.previewing) || Boolean(state.previewStale) || !state.history?.available;
    clearHistory.disabled = !canAct() || !state.rows.length;
    confirmHistory.disabled = clearHistory.disabled;
    if (state.running || state.previewStale || !previewEnabled) confirmHistory.hidden = true;
    diagnostic.update(state.reviewError || state.message, state.phase === 'error', state.running || Boolean(state.history?.busy));
    const extractionEnabled = Boolean(settings && isFeatureEnabled(settings, 'question-extract'));
    const identity = JSON.stringify(state.rows.map(row => [row.id, row.target.frameId, row.target.documentId, row.target.documentKey,
      row.target.scopeKey, row.target.question.fingerprint]));
    if (identity !== paperIdentity || state.previewStale || !extractionEnabled) { paperIdentity = identity; clearCopy(); }
    if (!enabled || saving || state.running) clearConfirmation();
    phase.textContent = state.reviewing ? '复检中' : state.running && state.mode === 'search' ? '搜题中' : phaseLabels[state.phase];
    operationControls.hidden = Boolean(dependencies.embedded) || !dependencies.answer.setMode;
    mode.value = state.mode ?? 'fill'; range.value = state.range ?? 'all';
    mode.disabled = range.disabled = !enabled || saving || state.running || Boolean(state.previewing) || Boolean(state.history?.busy);
    const readOnlyPaper = Boolean(state.rows.length && state.rows.every(row => row.readOnly));
    mode.querySelector<HTMLOptionElement>('option[value=fill]')!.disabled = readOnlyPaper;
    anchor.textContent = readOnlyPaper ? '回看 / 只读页面：可搜索参考答案，不能自动填写。'
      : (state.range === 'current' || state.range === 'forward') && selectedRow() ? `起点：${selectedRow()!.target.question.number} · ${state.range === 'current' ? '仅本题' : '当前题及后续'}` : '范围限于当前已加载内容；填写后请核对平台保存状态。';
    phase.dataset.phase = state.reviewing ? 'running' : state.phase;
    if (source.value !== (state.source ?? '')) source.value = state.source ?? '';
    source.disabled = !enabled || saving || state.running || Boolean(state.sourceSaving) || Boolean(state.history?.busy);
    localBank.update(enabled && !saving && !state.running && !state.sourceSaving);
    const notice = answerSourceNotice(state);
    const sourcesReady = Boolean(notice.first);
    configuration.hidden = !enabled;
    if (!sourcesReady) configuration.open = true;
    else if (!sourcesWereReady) configuration.open = false;
    sourcesWereReady = sourcesReady;
    const modeLabel = state.source === 'local' ? '仅本地' : state.source === 'ai' ? '仅 AI' : state.source === 'bank' ? '仅言溪' : state.source === 'prefer-bank' ? '言溪优先' : '请选择来源';
    configurationSummary.textContent = `答题设置 · ${modeLabel}`;
    sourceStatus.textContent = notice.message;
    sourceStatus.dataset.kind = notice.first ? 'info' : 'warning';
    sourceStatus.hidden = !enabled || Boolean(notice.first);
    recheck.hidden = !state.sourcesError;
    recheck.disabled = state.running;
    message.textContent = localError || (!settings ? '正在读取工具箱设置…' : !settings.enabled ? '工具箱已暂停，请先启用工具箱。'
      : !previewEnabled ? '题目提取与答题功能均已关闭，请在功能设置中启用。' : state.message);
    message.dataset.kind = localError || state.phase === 'error' ? 'error' : 'info';
    message.hidden = !localError && previewEnabled && state.phase !== 'error' && Boolean(state.rows.length) && !state.previewStale
      && isRoutineMessage(state.message);
    const filled = state.rows.filter(row => row.phase === 'filled').length;
    const processed = state.rows.filter(row => row.phase !== 'pending' && row.phase !== 'querying').length;
    const searched = state.rows.filter(row => row.resultAnswer).length;
    progress.textContent = state.rows.length ? enabled ? `已获取 ${searched} · 已处理 ${processed} / ${state.rows.length} · 已填入 ${filled}` : `已读取 ${state.rows.length} 题 · 仅阅览`
      : '阅览当前已加载题目';
    follow.hidden = !dependencies.answer.followProgress || state.followProgress !== false || !state.activeId;
    follow.disabled = Boolean(state.previewStale);
    inspect.textContent = state.previewing ? '正在读取…' : state.rows.length ? '刷新题目' : '识别当前页';
    inspect.disabled = state.running || Boolean(state.previewing) || Boolean(state.history?.busy) || saving || !previewEnabled;
    inspect.hidden = !dependencies.answer.preview || state.running;
    if (inspect.parentElement !== actions) actions.prepend(inspect);
    const paper = state.papers?.length === 1 ? state.papers[0] : undefined;
    // 章节测验叫「保存」，独立作业/考试叫「暂时保存」；提示文案跟页面按钮对齐。
    const saveLabel = paper?.scene === 'chapter-test' ? '保存' : '暂时保存';
    const allLoaded = state.papers?.length && state.papers.every(item => item.allLoaded);
    paperStatus.hidden = !state.rows.length || Boolean(allLoaded && !state.previewStale);
    paperStatus.textContent = state.previewStale ? `上次阅览（页面已更换）· ${state.rows.length} 题，请刷新阅览`
      : `仅阅览已加载题目；整卷复检前请先在页面点「${saveLabel}」再刷新阅览`;
    paperStatus.dataset.kind = state.previewStale ? 'warning' : 'info';
    const completionLabels = { saving: '正在暂时保存…', submitting: '正在提交…', saved: '已暂时保存 · 待提交', submitted: '平台已确认提交成功', unconfirmed: '尚未确认保存或提交成功，请检查页面提示' };
    completion.hidden = !state.completion && !state.rows.some(row => row.phase === 'filled');
    completion.textContent = state.completion ? completionLabels[state.completion] : '页面已填写并回读；平台保存状态待确认，请检查原网页。';
    completion.dataset.kind = state.completion === 'unconfirmed' ? 'warning' : 'info';
    const showRunActions = dependencies.showRunActions?.() ?? true;
    start.hidden = !enabled || state.running || !showRunActions;
    start.disabled = !canStart();
    start.textContent = dependencies.embedded ? '仅本次答题' : state.phase === 'paused' ? '继续处理' : state.mode === 'search' ? '搜索所选题目' : '填写所选题目';
    start.title = state.previewStale ? '页面已变化，请先刷新题目。' : !state.rows.length ? '请先识别当前页题目。'
      : state.mode === 'search' ? '仅搜索所选范围的参考答案，不填写或交卷。'
        : state.rows.every(row => row.readOnly || !row.target.question.supported) ? '当前题目为只读或暂不支持，请切换只搜题。' : '处理当前已识别题目，保留已有答案。';
    stop.hidden = !enabled || Boolean(dependencies.embedded) || !state.running || !showRunActions;
    featureSettings.hidden = !settings || !settings.enabled || (enabled && state.sources?.ai.enabled !== false);
    const reviewSupported = Boolean(dependencies.answer.reviewAnswers);
    const allRowsInPaper = Boolean(paper && paper.rowIds.length === state.rows.length
      && paper.rowIds.every(id => state.rows.some(row => row.id === id)));
    const incomplete = state.rows.filter(row => !isCompleteApplicableAnswer(row.target.question, row.currentAnswer));
    const unsupported = state.rows.filter(row => !row.target.question.supported);
    const hasImages = state.rows.some(row => row.target.question.images.length);
    let reviewReason = '';
    if (!reviewSupported) reviewReason = '当前版本未接入整卷复检。';
    else if (!enabled) reviewReason = '请先开启批量答题功能。';
    else if (state.reviewing) reviewReason = state.reviewProgress || '正在复检整卷…';
    else if (!state.rows.length || !state.papers?.length) reviewReason = '读取整卷后可用。';
    else if (state.previewStale) reviewReason = '题目页面已更换，请先刷新阅览。';
    else if (state.papers.length !== 1 || !allRowsInPaper) reviewReason = '仅支持单一且完整的整卷。';
    else if (paper?.complete) reviewReason = '平台已显示本卷完成，不能再复检。';
    else if (!paper?.allLoaded) reviewReason = `尚未核实整卷题量或页面仍有分页：请先在页面点「${saveLabel}」再刷新阅览。`;
    else if (unsupported.length) reviewReason = `仍有 ${unsupported.length} 道题不支持复检。`;
    else if (state.rows.some(row => row.target.question.textRecognition?.status === 'pending')) reviewReason = '仍有题目文字正在识别。';
    else if (state.rows.some(row => row.readOnly)) reviewReason = '仍有题目控件未就绪或只可阅览。';
    else if (state.sourcesError || !state.sources) reviewReason = '正在读取 AI 配置，请稍候。';
    else if (!state.sources.ai.enabled) reviewReason = 'AI 作答功能未启用。';
    else if (!state.sources.ai.configured || !state.sources.ai.authorized) reviewReason = '尚未配置并授权 AI 接口。';
    else if (hasImages && state.sources.ai.supportsImages !== true) reviewReason = '整卷含图片题，请先启用支持图片输入的模型。';
    else if (incomplete.length) reviewReason = `还有 ${incomplete.length} 道题未完整作答。`;
    else if (state.running || saving || state.sourceSaving) reviewReason = state.reviewing ? '正在复检整卷…' : '当前已有其他答题任务。';
    reviewActions.hidden = !enabled || !reviewSupported;
    reviewButton.hidden = !reviewSupported;
    reviewButton.textContent = state.reviewing ? '复检进行中…' : state.reviewAvailable ? '核对并复用复检结果' : 'AI 整卷复检';
    reviewButton.disabled = !enabled || Boolean(state.reviewing) || Boolean(reviewReason) || Boolean(state.previewing) || Boolean(state.history?.busy);
    reviewStop.hidden = !state.reviewing;
    reviewAgain.hidden = !state.reviewAvailable || Boolean(state.reviewing);
    reviewAgain.disabled = reviewButton.disabled;
    confirmReview.disabled = reviewAgain.disabled;
    if (state.running || !state.reviewAvailable) reviewConfirm.hidden = true;
    reviewButton.setAttribute('aria-busy', String(Boolean(state.reviewing)));
    reviewStatus.hidden = !reviewSupported;
    reviewStatus.textContent = state.reviewError || state.reviewProgress || reviewReason
      || (state.rows.some(row => row.review?.status === 'suspect') ? '红色题目为 AI 发现的疑似错误。' : '')
      || (state.rows.some(row => row.review?.status === 'uncertain') ? '橙色题目需要你人工确认。' : '')
      || '整卷已满足复检条件。';
    reviewStatus.dataset.kind = state.reviewError ? 'error'
      : state.rows.some(row => row.review?.status === 'suspect') ? 'suspect'
        : state.rows.some(row => row.review?.status === 'uncertain') ? 'uncertain'
          : reviewReason && !state.reviewing ? 'muted' : 'info';
    rows.hidden = state.rows.length === 0;
    grid.hidden = state.rows.length === 0;
    copyActions.hidden = !extractionEnabled || !state.rows.length;
    copyCurrent.disabled = !canCopy();
    copyAll.disabled = !canCopy();
    resultExport.update(state, Boolean(settings?.enabled && (settings.features['question-extract'] || settings.features['question-answer']) && !saving));
    copyStatus.hidden = !copyStatus.textContent;
    const count = state.rows.filter(row => answerDifference(row)?.status === 'suspect').length;
    differences.hidden = !count;
    differenceText.textContent = `≠ ${count} 道答案不一致，请核对`;
    nextDifference.disabled = Boolean(state.previewing);
    renderRows();
  }

  async function openSettings(section: SettingsSection): Promise<void> {
    try { await dependencies.openSettings(section); }
    catch { if (!disposed) { localError = '无法打开设置，请从扩展菜单进入设置页。'; render(); } }
  }
  start.addEventListener('click', () => {
    if (!canStart()) return;
    clearConfirmation(); localError = ''; dependencies.answer.start();
  }, { signal });
  stop.addEventListener('click', () => { clearConfirmation(); dependencies.answer.stop(); }, { signal });
  mode.addEventListener('change', () => { if (!canAct()) return; clearConfirmation(); if (mode.value === 'search' || mode.value === 'fill') dependencies.answer.setMode?.(mode.value); }, { signal });
  range.addEventListener('change', () => { if (!canAct()) return; clearConfirmation(); if (range.value === 'all' || range.value === 'current' || range.value === 'forward') dependencies.answer.setRange?.(range.value); }, { signal });
  source.addEventListener('change', () => {
    if (!canAct()) return;
    clearConfirmation();
    if (source.value === 'bank' || source.value === 'ai' || source.value === 'prefer-bank' || source.value === 'local') dependencies.answer.setSource(source.value);
  }, { signal });
  bankSettings.addEventListener('click', () => { void openSettings('question-bank'); }, { signal });
  aiSettings.addEventListener('click', () => { void openSettings('api'); }, { signal });
  featureSettings.addEventListener('click', () => { void openSettings('features'); }, { signal });
  recheck.addEventListener('click', () => dependencies.answer.refreshSources(), { signal });
  restoreHistory.addEventListener('click', () => { if (!restoreHistory.disabled) dependencies.answer.restoreHistory?.(); }, { signal });
  clearHistory.addEventListener('click', () => { if (!clearHistory.disabled) confirmHistory.hidden = !confirmHistory.hidden; }, { signal });
  confirmHistory.addEventListener('click', () => { if (!confirmHistory.disabled) { confirmHistory.hidden = true; dependencies.answer.clearHistory?.(); } }, { signal });
  inspect.addEventListener('click', () => { if (!inspect.disabled) dependencies.answer.preview?.(); }, { signal });
  copyCurrent.addEventListener('click', () => { void copyQuestions(false); }, { signal });
  copyAll.addEventListener('click', () => { void copyQuestions(true); }, { signal });
  follow.addEventListener('click', () => { clearConfirmation(); dependencies.answer.followProgress?.(); }, { signal });
  reviewButton.addEventListener('click', () => {
    if (reviewButton.disabled) return;
    clearConfirmation();
    localError = '';
    dependencies.answer.reviewAnswers?.();
  }, { signal });
  reviewStop.addEventListener('click', () => { if (state.reviewing) dependencies.answer.stop(); }, { signal });
  reviewAgain.addEventListener('click', () => { if (!reviewAgain.disabled) reviewConfirm.hidden = false; }, { signal });
  cancelReview.addEventListener('click', () => { reviewConfirm.hidden = true; }, { signal });
  confirmReview.addEventListener('click', () => { if (!confirmReview.disabled && !reviewConfirm.hidden) { reviewConfirm.hidden = true; dependencies.answer.reviewAnswers?.(true); } }, { signal });
  nextDifference.addEventListener('click', () => {
    const matches = state.rows.filter(row => answerDifference(row)?.status === 'suspect');
    if (!matches.length) return;
    const index = matches.findIndex(row => row.id === selectedRow()?.id);
    localSelectedId = matches[(index + 1) % matches.length].id;
    clearConfirmation(); dependencies.answer.selectQuestion?.(localSelectedId); render();
    rowViews.get(localSelectedId)?.element.scrollIntoView({ block: 'nearest' });
  }, { signal });
  const unsubscribe = dependencies.answer.subscribe(value => { const finished = state.running && !value.running; state = value; localError = ''; render(); if (finished) void usage.refresh(); });
  render();
  return {
    element: root,
    actions,
    update(value, pending) { settings = value; saving = pending; exchange.update(value, pending); render(); },
    refresh() { state = dependencies.answer.getState(); dependencies.answer.refreshSources(); dependencies.answer.preview?.(); render(); },
    dispose() { disposed = true; clearCopy(); unsubscribe(); listeners.abort(); exchange.dispose(); resultExport.dispose(); localBank.dispose(); usage.dispose(); flowView?.dispose(); rowViews.clear(); numberViews.clear(); root.remove(); },
  };
}
