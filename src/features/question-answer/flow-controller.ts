import type { AnswerRuntime } from './client';
import type { AnswerFrameSnapshot } from './background';
import type { PaperFlowInfo, QuestionAnswerController } from './types';

export interface PaperFlowProgress { attemptKey: string; visited: string[]; pages: number; processed: number; filled: number; saved: number }
export interface PaperFlowState { running: boolean; message: string; info?: PaperFlowInfo; progress?: PaperFlowProgress; resumable: boolean }
export interface PaperFlowController {
  getState(): PaperFlowState; subscribe(listener: (state: PaperFlowState) => void): () => void;
  inspect(): void; start(resume?: boolean): void; stop(): void; dispose(): void;
}
interface Dependencies {
  runtime: AnswerRuntime; answer: QuestionAnswerController; stopAnswer(): void; isEnabled(): boolean;
  load(): Promise<PaperFlowProgress | undefined>; save(value: PaperFlowProgress): Promise<void>; clear(): Promise<void>;
}
export function createPaperFlowController(deps: Dependencies): PaperFlowController {
  let state: PaperFlowState = { running: false, message: '先检查本页的分页与保存入口。', resumable: false };
  let active: AbortController | undefined; let disposed = false; const listeners = new Set<(state: PaperFlowState) => void>();
  const emit = (patch: Partial<PaperFlowState>) => { if (disposed) return; state = { ...state, ...patch }; for (const l of listeners) l(structuredClone(state)); };
  const check = (signal: AbortSignal) => { if (signal.aborted || disposed || !deps.isEnabled()) throw new DOMException('跨页处理已暂停。', 'AbortError'); };
  const delay = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    check(signal); const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
    const abort = () => { clearTimeout(timer); reject(new DOMException('已暂停。', 'AbortError')); }; signal.addEventListener('abort', abort, { once: true });
  });
  async function inspect(signal: AbortSignal): Promise<{ frame: AnswerFrameSnapshot; info: PaperFlowInfo }> {
    check(signal); const frames = (await deps.runtime.scan(signal)).filter(f => ['exam','homework'].includes(f.snapshot.scene) && f.snapshot.questions.length);
    if (frames.length !== 1) throw new Error('当前试卷框架不唯一或未加载，暂不自动跨页。');
    const frame = frames[0]; const result = await deps.runtime.page(frame, { action: 'flow', operation: 'inspect', documentKey: frame.snapshot.documentKey, scopeKey: frame.snapshot.scopeKey }, signal);
    if (!result.flow) throw new Error('此页面尚未提供分页能力。'); return { frame, info: result.flow };
  }
  async function run(resume: boolean) {
    if (active || disposed || deps.answer.getState().running || !deps.isEnabled()) return;
    const abort = new AbortController(); active = abort; emit({ running: true, message: '正在核对跨页范围…' });
    try {
      let current = await inspect(abort.signal); check(abort.signal);
      if (!current.info.attemptKey || !current.info.page || (!current.info.canNext && !current.info.terminal)) throw new Error(current.info.reason);
      const previous = resume ? await deps.load() : undefined; check(abort.signal);
      if (previous && previous.attemptKey !== current.info.attemptKey) throw new Error('上次进度属于其他试卷，本页未恢复。');
      const progress: PaperFlowProgress = previous ?? { attemptKey: current.info.attemptKey, visited: [], pages: 0, processed: 0, filled: 0, saved: 0 };
      const mode = deps.answer.getState().mode ?? 'fill';
      while (true) {
        check(abort.signal); const { frame, info } = current;
        if (info.attemptKey !== progress.attemptKey) throw new Error('试卷已切换，已停止旧任务。');
        if (progress.visited.length >= 1000) throw new Error('本轮已达 1000 页，请分段处理。');
        if (!progress.visited.includes(info.pageKey)) {
          if (mode === 'fill' && !info.canSave) throw new Error('当前页无法确认草稿保存，已停留；可改用只搜题模式。');
          emit({ info, progress: structuredClone(progress), message: `正在处理第 ${info.page}${info.total ? `/${info.total}` : ''} 页…` });
          // Rebuild row IDs before starting: the ordinary queue intentionally binds its range to the preview.
          deps.answer.preview?.(); await delay(abort.signal);
          while (deps.answer.getState().previewing) await delay(abort.signal);
          const preview = deps.answer.getState();
          if (preview.previewStale || preview.rows.length !== frame.snapshot.questions.length
            || preview.rows.some(row => row.target.documentKey !== frame.snapshot.documentKey || row.target.scopeKey !== frame.snapshot.scopeKey
              || !frame.snapshot.questions.some(q => q.key === row.target.question.key && q.fingerprint === row.target.question.fingerprint))) throw new Error('本页题目在预览期间变化，请重新检查。');
          deps.answer.setRange?.('all'); deps.answer.start();
          const until = Date.now() + 30 * 60 * 1000;
          while (deps.answer.getState().running) { if (Date.now() > until) throw new Error('本页处理超时，请分段检查。'); await delay(abort.signal); }
          check(abort.signal); const result = deps.answer.getState();
          if (result.phase !== 'complete' || !result.rows.length || result.rows.some(r => !['filled','existing','searched'].includes(r.phase))) throw new Error('本页仍有未处理或需核对题目，已暂停跨页。');
          if ((result.mode ?? 'fill') !== mode) throw new Error('处理模式已改变，已暂停跨页。');
          const expected: Array<{ key: string; fingerprint: string; version: string }> = [];
          if (mode === 'fill') {
            for (const row of result.rows) {
              const target = row.target; const read = await deps.runtime.page(target, { action: 'read', documentKey: target.documentKey, scopeKey: target.scopeKey, key: target.question.key, fingerprint: target.question.fingerprint }, abort.signal);
              if (!read.control?.ready || !read.control.complete) throw new Error('本页仍有不完整答案，未保存或翻页。');
              expected.push({ key: target.question.key, fingerprint: target.question.fingerprint, version: read.control.version });
            }
            emit({ message: '正在等待本次答案的草稿保存确认…' });
            const saved = await deps.runtime.page(frame, { action: 'flow', operation: 'save', documentKey: frame.snapshot.documentKey, scopeKey: frame.snapshot.scopeKey, attemptKey: info.attemptKey, pageKey: info.pageKey, expected }, abort.signal);
            if (saved.outcome !== 'saved') throw new Error('平台未确认本页保存，未翻页。');
            progress.saved += result.rows.length;
          }
          check(abort.signal); progress.processed += result.rows.length; progress.filled += result.rows.filter(r => r.phase === 'filled').length; progress.pages++;
          progress.visited.push(info.pageKey); await deps.save(progress); check(abort.signal);
          emit({ progress: structuredClone(progress) });
          if (info.terminal) { await deps.clear(); emit({ message: `当前起点至末页处理完成：${progress.pages} 页、${progress.processed} 题，已确认保存 ${progress.saved} 题。最终检查和交卷由你操作。`, resumable: false }); return; }
          emit({ message: '本页已处理，准备进入下一页…' });
          await deps.runtime.page(frame, { action: 'flow', operation: 'next', documentKey: frame.snapshot.documentKey, scopeKey: frame.snapshot.scopeKey, attemptKey: info.attemptKey, pageKey: info.pageKey, ...(mode === 'fill' ? { expected } : {}) }, abort.signal);
        } else {
          // A document reload is a new write context: never reuse prior saved-control proofs.
          throw new Error('当前页已有本轮处理记录。请手动进入后续页，再恢复进度，避免重复填写。');
        }
        const until = Date.now() + 12000; let next: typeof current | undefined;
        while (Date.now() < until) {
          await delay(abort.signal);
          try { const value = await inspect(abort.signal); if (value.info.attemptKey !== progress.attemptKey) throw new Error('试卷已变化');
            if (value.info.pageKey !== info.pageKey && value.info.page > info.page) { next = value; break; }
          } catch (e) { check(abort.signal); if (e instanceof Error && /试卷已变化/.test(e.message)) throw e; }
        }
        if (!next) throw new Error('下一页未在限定时间内就绪，请检查页面后恢复；不会循环点击。'); current = next;
      }
    } catch (e) { if (!disposed) emit({ message: e instanceof Error ? e.message : '跨页处理失败，请检查原网页。', resumable: true }); }
    finally { if (active === abort) { active = undefined; deps.stopAnswer(); emit({ running: false }); } }
  }
  function stop() { active?.abort(); deps.stopAnswer(); emit({ running: false, message: '跨页处理已暂停，进度保留；不会继续请求、填写或翻页。', resumable: Boolean(state.progress) }); }
  void deps.load().then(value => { if (value && !active) emit({ progress: value, resumable: true, message: '发现本标签页的跨页进度，检查当前试卷后可恢复。' }); }).catch(() => {});
  return { getState: () => structuredClone(state), subscribe(l) { listeners.add(l); l(structuredClone(state)); return () => listeners.delete(l); },
    inspect() { if (active) return; const a = new AbortController(); void inspect(a.signal).then(({ info }) => emit({ info, message: info.reason })).catch(e => emit({ message: e instanceof Error ? e.message : '分页检查失败。' })); },
    start(resume = false) { void run(resume); }, stop,
    dispose() { stop(); disposed = true; listeners.clear(); },
  };
}

export function createPaperFlowView(controller: PaperFlowController) {
  const element = document.createElement('details'); element.className = 'answer-configuration paper-flow'; const title = document.createElement('summary'); title.textContent = '当前页及后续页 · 实验适配';
  const help = document.createElement('p'); help.className = 'editor-hint'; help.textContent = '先检查分页入口。填写模式每页确认草稿保存后才继续；最终交卷由你操作。真实页面兼容性仍需核对。';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); const progress = document.createElement('p'); const actions = document.createElement('div'); actions.className = 'answer-settings-actions';
  const button = (label: string, run: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'button'; b.textContent = label; b.onclick = run; return b; };
  const inspect = button('检查分页入口', () => controller.inspect()); const start = button('从当前页开始跨页', () => controller.start()); const resume = button('恢复跨页进度', () => controller.start(true)); const stop = button('暂停跨页', () => controller.stop());
  actions.append(inspect, start, resume, stop); element.append(title, help, progress, status, actions);
  const unsubscribe = controller.subscribe(state => { status.textContent = state.message; progress.textContent = state.progress ? `已处理 ${state.progress.pages} 页 / ${state.progress.processed} 题 · 已填写 ${state.progress.filled} 题 · 已确认保存 ${state.progress.saved} 题` : '';
    inspect.disabled = start.disabled = state.running; resume.hidden = !state.resumable; resume.disabled = state.running; stop.hidden = !state.running; });
  return { element, dispose() { unsubscribe(); element.remove(); } };
}
