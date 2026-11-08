import { assessmentSceneFromUrl } from '../../platform/assessment-routes';
import { visible, readQuestionControl, type PageInspection } from './adapters/chaoxing';
import type { AnswerPageCommand, AnswerPageResult, PaperFlowInfo } from './types';

const saved = new WeakMap<Document, string>();
const clean = (text: string | null) => (text ?? '').replace(/\s+/g, '').trim();
const disabled = (element: HTMLElement) => element.hasAttribute('disabled') || Boolean(element.closest('[aria-disabled="true"],.is-disabled,.disabled'));
function hash(text: string) { let a = 2166136261, b = 5381; for (const c of text) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0); } return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`; }
function attempt(win: Window): string {
  if (!assessmentSceneFromUrl(win.location.href)) return '';
  const url = new URL(win.location.href); const ids: Array<[string, string]> = [];
  for (const name of ['examId','examid','paperId','paperid','workId','workid','testId','workAnswerId','answerId','attemptId']) {
    const values = [...new Set([url.searchParams.get(name) ?? '', ...Array.from(win.document.querySelectorAll<HTMLInputElement>(`input[name="${name}"],input[id="${name}"]`), n => n.value)].filter(Boolean))];
    if (values.length > 1 || values.some(v => !/^[\w-]{1,100}$/.test(v))) return '';
    if (values.length) ids.push([name.toLowerCase(), values[0]]);
  }
  if (!ids.length) return '';
  return `paper:${url.hostname}:${hash(JSON.stringify(ids))}`;
}
function nativeNext(doc: Document): HTMLElement | undefined {
  const controls = [...doc.querySelectorAll<HTMLElement>('.el-pagination .btn-next,.pagination .next a,.pagination .next button,.pager .next a,.pager button.next,a[rel="next"],[onclick*="getTheNextQuestion"],[onclick*="nextQuestion"]')]
    .filter(e => visible(e) && !e.closest('#cx-toolbox-root,[data-cx-toolbox]') && !/提交|交卷|结束|返回/.test(e.textContent ?? ''));
  return controls.length === 1 ? controls[0] : undefined;
}
function nativeSave(doc: Document): HTMLElement | undefined {
  const controls = [...doc.querySelectorAll<HTMLElement>('main button,form button,.exam-paper button,.exam-content button,.exam-paper a,.exam-content a')]
    .filter(e => visible(e) && !disabled(e) && !e.closest('#cx-toolbox-root,[data-cx-toolbox]') && /^(保存草稿|保存答案|暂存答案|暂存)$/.test(clean(e.textContent)));
  return controls.length === 1 ? controls[0] : undefined;
}
export function inspectPaperFlow(win: Window, inspection: PageInspection): PaperFlowInfo {
  const doc = win.document; const attemptKey = attempt(win); const next = nativeNext(doc);
  const active = doc.querySelector('.el-pager .active,.pagination .active,[aria-current="page"]');
  const url = new URL(win.location.href);
  const raw = clean(active?.textContent ?? '') || doc.querySelector<HTMLInputElement>('input[name="currentPage"],input[name="pageNum"]')?.value
    || url.searchParams.get('currentPage') || url.searchParams.get('pageNum') || '';
  const page = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  const totalText = doc.querySelector('.el-pagination,.pagination,.pager')?.textContent ?? '';
  const declared = /共\s*(\d+)\s*页/.exec(totalText); const total = declared ? Number(declared[1]) : undefined;
  const terminal = Boolean(page && total && page === total && (!next || disabled(next)));
  const canNext = Boolean(attemptKey && page && next && !disabled(next) && (total === undefined || page < total));
  const canSave = Boolean(attemptKey && !inspection.snapshot.complete && nativeSave(doc));
  return { attemptKey, pageKey: hash(JSON.stringify([attemptKey, page, inspection.entries.map(e => [e.snapshot.key, e.snapshot.fingerprint])])),
    page, ...(total ? { total } : {}), canNext, terminal, canSave,
    reason: !attemptKey ? '缺少稳定试卷标识，当前仅处理已加载内容。' : !page ? '页码未能核实，当前仅处理已加载内容。' : terminal ? '已到平台声明的最后一页。'
      : !canNext ? '未找到唯一可用的原生下一页入口。' : !canSave ? '可搜题翻页；填写模式仍需要核实草稿保存入口。' : '检测到分页和草稿保存入口，需实机核对兼容性。' };
}
function versions(win: Window, inspection: PageInspection) {
  return inspection.entries.map(e => { const control = readQuestionControl(win, e); if (!control.ready || !control.complete) throw new Error('本页仍有未完整填写的题目，请先检查。'); return { key: e.snapshot.key, fingerprint: e.snapshot.fingerprint, version: control.version }; });
}
function notifications(win: Window): Map<Element, string> {
  return new Map([...win.document.querySelectorAll('.el-message,.el-notification,[role="status"],.save-status,.saveTip')].filter(e => visible(e) && !e.closest('#cx-toolbox-root,[data-cx-toolbox]')).map(e => [e, clean(e.textContent)]));
}
export async function handlePaperFlow(win: Window, command: Extract<AnswerPageCommand, { action: 'flow' }>, signal: AbortSignal, inspect: () => PageInspection): Promise<AnswerPageResult> {
  const constructors = win as Window & typeof globalThis;
  function verify() {
    if (signal.aborted) throw new DOMException('跨页已暂停。', 'AbortError');
    const inspection = inspect();
    if (inspection.snapshot.documentKey !== command.documentKey || inspection.snapshot.scopeKey !== command.scopeKey) throw new Error('页面已变化，请重新识别。');
    const flow = inspectPaperFlow(win, inspection);
    if (command.operation !== 'inspect' && (!flow.attemptKey || flow.attemptKey !== command.attemptKey || flow.pageKey !== command.pageKey)) throw new Error('试卷或页码已变化，旧操作已停止。');
    if (command.expected && JSON.stringify(versions(win, inspection)) !== JSON.stringify(command.expected)) throw new Error('本页答案已变化，请重新核对。');
    return { inspection, flow };
  }
  const { inspection, flow } = verify();
  if (command.operation === 'inspect') return { ok: true, flow };
  if (command.operation === 'save') {
    if (!flow.canSave || !command.expected?.length) throw new Error('当前页没有已核实的草稿保存入口，或题目未完整填写。');
    const before = notifications(win); const button = nativeSave(win.document)!;
    if (button instanceof constructors.HTMLButtonElement && button.type === 'submit') throw new Error('保存入口会提交表单，需人工核实，未点击。');
    verify(); button.click(); const until = Date.now() + 6000;
    while (Date.now() < until) {
      verify();
      for (const [element, text] of notifications(win)) {
        if (before.get(element) !== text && /^(?:答案|草稿)?(?:保存成功|已保存|暂存成功)[！!。]?$/.test(text)) {
          saved.set(win.document, JSON.stringify([flow.attemptKey, flow.pageKey, command.expected])); return { ok: true, outcome: 'saved', flow };
        }
      }
      await new Promise(resolve => win.setTimeout(resolve, 80));
    }
    throw new Error('未确认本次答案已保存，已停留本页。请在原网页核对保存结果。');
  }
  if (!flow.canNext) throw new Error(flow.reason);
  if (command.expected && saved.get(win.document) !== JSON.stringify([flow.attemptKey, flow.pageKey, command.expected])) throw new Error('本页答案尚未确认保存，未翻页。');
  if (!inspection.entries.length) throw new Error('当前页题目尚未加载。');
  const next = nativeNext(win.document)!;
  if (next instanceof constructors.HTMLAnchorElement) {
    const href = next.getAttribute('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      const target = new URL(href, win.location.href);
      if (target.origin !== win.location.origin || !assessmentSceneFromUrl(target.href)) throw new Error('下一页地址不属于当前平台的已识别试卷，未跳转。');
    }
  }
  if (next instanceof constructors.HTMLButtonElement && next.type === 'submit') throw new Error('下一页入口会提交表单，请人工核实。');
  verify(); next.click(); return { ok: true, flow };
}
