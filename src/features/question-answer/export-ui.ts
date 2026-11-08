import { hasAnswerContent, createQuestionResultsFile, type ResultsExportFile } from './export';
import type { QuestionAnswerState } from './types';
import { createResultsTemplateFile } from '../local-question-bank/results-template';

export function downloadResultsFile(file: ResultsExportFile, doc = document): void {
  const win = doc.defaultView!;
  const blob = new win.Blob([file.content], { type: file.mime });
  const url = win.URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url; link.download = file.name;
  link.hidden = true;
  try {
    doc.body.append(link);
    link.click();
    // Keep the object URL alive until the browser has consumed the download.
    win.setTimeout(() => win.URL.revokeObjectURL(url), 60_000);
  } catch (error) { win.URL.revokeObjectURL(url); throw error; }
  finally { link.remove(); }
}

export function createResultsExportView(dependencies: {
  getState(): QuestionAnswerState;
  download?(file: ResultsExportFile): void;
}) {
  const listeners = new AbortController();
  const element = document.createElement('section');
  element.className = 'answer-export';
  element.setAttribute('aria-label', '导出题目与答案');
  element.innerHTML = `<div class="answer-export-controls"><label>导出格式<select aria-label="导出格式"><option value="txt">TXT · 直接阅读</option><option value="json">JSON · 结构数据</option><option value="bank">题库模板 TXT</option></select></label><label class="answer-template-origin" hidden>答案取自<select aria-label="题库模板答案来源"><option value="">请明确选择</option><option value="result">已获取的答案</option><option value="page">当前页面答案</option></select></label><button class="button" type="button">导出题目与答案</button></div><p class="answer-export-help"></p><p class="answer-export-status" role="status" aria-live="polite" hidden></p>`;
  const format = element.querySelector('select')!;
  const button = element.querySelector('button')!;
  const originLabel = element.querySelector<HTMLElement>('.answer-template-origin')!;
  const origin = originLabel.querySelector('select')!;
  const help = element.querySelector<HTMLElement>('.answer-export-help')!;
  const status = element.querySelector<HTMLElement>('.answer-export-status')!;
  let enabled = false;
  let disposed = false;
  let identity = '';

  function update(state: QuestionAnswerState, allowed: boolean) {
    if (disposed) return;
    enabled = allowed;
    const key = JSON.stringify([state.previewStale, state.rows.map(row => [row.id, row.target.question.fingerprint])]);
    if (key !== identity) { identity = key; status.hidden = true; status.textContent = ''; }
    element.hidden = state.rows.length === 0;
    button.disabled = !enabled || !state.rows.length;
    format.disabled = button.disabled;
    // Only count already-held values; rendering never makes a request or creates a file.
    const resultCount = state.rows.filter(row => hasAnswerContent(row.resultAnswer)).length;
    const pageCount = state.rows.filter(row => hasAnswerContent(row.currentAnswer)).length;
    help.textContent = `${state.previewStale ? '上次页面保留结果' : '当前已加载'} ${state.rows.length} 题 · 已获取答案 ${resultCount} 题 · 页面有答案 ${pageCount} 题。${state.running ? '正在处理，可导出此刻结果。' : ''}`;
    button.title = '下载当前列表的题目、选项、已有结果与状态；导出不调用 AI。';
  }
  format.addEventListener('change', () => { originLabel.hidden = format.value !== 'bank'; status.hidden = true; }, { signal: listeners.signal });
  button.addEventListener('click', () => {
    if (!enabled || disposed || button.disabled) return;
    const choice = format.value;
    if (choice !== 'txt' && choice !== 'json' && choice !== 'bank') return;
    try {
      if (choice === 'bank' && origin.value !== 'result' && origin.value !== 'page') throw new Error('请选择模板使用已获取答案还是页面答案；导出不会替你判断答案正确性。');
      const state = dependencies.getState();
      const file = choice === 'bank' ? createResultsTemplateFile(state, origin.value as 'result' | 'page', document.title) : createQuestionResultsFile(state, choice, document.title);
      (dependencies.download ?? downloadResultsFile)(file);
      status.textContent = `已发起 ${file.count} 题的文件下载，请在浏览器下载列表查看。${choice === 'bank' ? `跳过 ${state.rows.length - file.count} 题（无完整答案、含图片或复杂题型）。` : ''}`;
      status.dataset.kind = 'info';
    } catch (error) {
      status.textContent = error instanceof Error ? `导出失败：${error.message}` : '导出失败，请重试。';
      status.dataset.kind = 'error';
    }
    status.hidden = false;
  }, { signal: listeners.signal });
  return { element, update, dispose() { disposed = true; listeners.abort(); element.remove(); } };
}
