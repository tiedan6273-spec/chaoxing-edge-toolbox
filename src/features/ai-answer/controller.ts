import { isThinkLadderUrl, readThinkLadderState } from './adapters/think-ladder';
import type {
  AiAnswerController, AiAnswerState, AiControllerDependencies, AnswerSnapshot, CurrentQuestion, AiGeneratedAnswer,
} from './types';

const STABLE_DELAY_MS = 800;
const EDITOR_POLL_MS = 450;

function identity(question: CurrentQuestion): string {
  return `${question.key}:${question.fingerprint}`;
}

interface ActiveTask {
  question: CurrentQuestion;
  snapshot: AnswerSnapshot;
  abort: AbortController;
  writing: boolean;
}

/** One independent model request per real task. The page never owns API credentials. */
export function createAiAnswerController(deps: AiControllerDependencies): AiAnswerController {
  if (!isThinkLadderUrl(deps.document.location.href)) {
    const unsupported: AiAnswerState = { phase: 'unsupported', running: false,
      message: 'AI 作答目前仅支持思维阶梯页面的简答题。', answer: '', canConfirmReplace: false };
    return {
      getState: () => ({ ...unsupported }), subscribe(listener) { listener({ ...unsupported }); return () => {}; },
      start() {}, stop() {}, confirmReplace() {}, retry() {}, settingsChanged() {}, dispose() {},
    };
  }
  const win = deps.document.defaultView;
  if (!win) throw new Error('AI 作答需要网页上下文。');
  let state: AiAnswerState = {
    phase: 'paused', running: false, message: '已暂停。点击开始后，检测并填入当前简答题。',
    answer: '', canConfirmReplace: false,
  };
  const listeners = new Set<(value: AiAnswerState) => void>();
  const attempted = new Set<string>();
  const filled = new Set<string>();
  let disposed = false;
  let revision = 0;
  let evaluating = false;
  let polling = false;
  let token = '';
  let active: ActiveTask | undefined;
  let reference: { question: CurrentQuestion; snapshot: AnswerSnapshot; result: AiGeneratedAnswer } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mountedChat: Element | null = null;

  function getState(): AiAnswerState {
    return { ...state, ...(state.question ? { question: { ...state.question, knowledgePoints: [...state.question.knowledgePoints] } } : {}) };
  }

  function publish(patch: Partial<AiAnswerState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(getState());
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function cancel(): void {
    revision += 1;
    clearTimer();
    active?.abort.abort();
    active = undefined;
  }

  function schedule(reset = false): void {
    if (disposed || !state.running || active || evaluating || attempted.has(token)) return;
    if (timer && !reset) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void evaluate(false);
    }, STABLE_DELAY_MS);
  }

  function inspect(reset = false): void {
    if (disposed) return;
    const page = readThinkLadderState(deps.document);
    if (page.state !== 'question') {
      const nextToken = `page:${page.state}`;
      const nextPhase = page.state === 'waiting' && !state.running ? 'paused' : page.state;
      if (token !== nextToken || state.phase !== nextPhase || (page.state === 'complete' && state.running)) {
        cancel();
        token = nextToken;
        publish({
          phase: nextPhase,
          running: page.state === 'complete' || page.state === 'unsupported' ? false : state.running,
          question: undefined, message: page.message, canConfirmReplace: false,
        });
      }
      return;
    }
    const nextToken = identity(page.question);
    if (nextToken !== token) {
      cancel();
      reference = undefined;
      token = nextToken;
      publish({
        question: page.question, phase: state.running ? 'waiting' : 'paused',
        message: state.running ? '已识别简答题，等待题目稳定。' : '已识别当前简答题。点击开始自动填入。',
        canConfirmReplace: false, answer: '',
      });
    }
    if (state.running && filled.has(token)) {
      if (state.phase !== 'filled') publish({ phase: 'filled', message: '本题已填入，发送答案及进入下一题由你操作。', canConfirmReplace: false });
      return;
    }
    if (state.running) schedule(reset);
  }

  function taskCurrent(task: ActiveTask): boolean {
    return !disposed && state.running && deps.isEnabled() && active === task && !task.abort.signal.aborted;
  }

  function sameQuestion(question: CurrentQuestion): boolean {
    const page = readThinkLadderState(deps.document);
    return page.state === 'question' && identity(page.question) === identity(question);
  }

  function blockForEdit(message: string): void {
    cancel();
    publish({ phase: 'blocked', message, canConfirmReplace: true });
  }

  async function evaluate(replace: boolean): Promise<void> {
    if (disposed || evaluating || active || !state.running || !deps.isEnabled()) return;
    const startedAt = Date.now();
    const page = readThinkLadderState(deps.document);
    if (page.state !== 'question') { inspect(); return; }
    const question = page.question;
    const currentToken = identity(question);
    if (currentToken !== token) { inspect(); return; }
    if (!replace && (attempted.has(currentToken) || filled.has(currentToken))) return;
    const ownRevision = revision;
    evaluating = true;
    try {
      const configured = await deps.apiConfigured();
      if (disposed || ownRevision !== revision || !state.running) return;
      if (!configured) {
        publish({ phase: 'needs-config', running: false, message: '当前答案来源未就绪，请检查选库、在线来源和域名授权。', canConfirmReplace: false });
        return;
      }
      const initial = await deps.readAnswer();
      if (disposed || ownRevision !== revision || !state.running || !deps.isEnabled()) return;
      if (!sameQuestion(question)) { inspect(); return; }
      if (!initial.ready) {
        publish({ phase: 'waiting', message: initial.error ?? '等待答题编辑器就绪。', canConfirmReplace: false });
        return;
      }
      if (initial.hasContent && !replace && state.mode !== 'search') {
        // A blocked question is also attempted so DOM mutations cannot bypass consent.
        attempted.add(currentToken);
        publish({ phase: 'blocked', message: '答题框已有内容，暂不生成。', canConfirmReplace: true });
        return;
      }
      const task: ActiveTask = { question, snapshot: initial, abort: new AbortController(), writing: false };
      active = task;
      attempted.add(currentToken);
      publish({ phase: 'generating', message: '正在独立生成本题回答…', answer: '', canConfirmReplace: false });
      try {
        const generated = reference && identity(reference.question) === currentToken && reference.snapshot.version === initial.version
          ? reference.result : await deps.generate(question, task.abort.signal, (text) => {
          if (taskCurrent(task) && text !== state.answer) publish({ answer: text });
        }, message => { if (taskCurrent(task)) publish({ message }); });
        if (!taskCurrent(task)) return;
        const result = typeof generated === 'string' ? { text: generated } : generated;
        const answer = result.text;
        reference = { question, snapshot: initial, result };
        publish({ answer, source: result.source, applyNeedsReplace: initial.hasContent });
        if (!answer.trim()) throw new Error('模型没有返回有效回答，请检查配置后重试。');
        if (state.mode === 'search') {
          active = undefined; publish({ phase: 'searched', running: false, message: '已获取参考答案，尚未填写。', canConfirmReplace: false }); return;
        }
        await deps.waitBeforeFill?.(startedAt, task.abort.signal, message => { if (taskCurrent(task)) publish({ message }); });
        if (!taskCurrent(task)) return;
        if (!sameQuestion(question)) { inspect(); return; }
        const latest = await deps.readAnswer();
        if (!taskCurrent(task)) return;
        if (!sameQuestion(question)) { inspect(); return; }
        if (!latest.ready) throw new Error(latest.error ?? '编辑器不可用，生成的回答已保留。');
        if (latest.version !== initial.version) {
          blockForEdit('生成期间答题框发生变化，已保留你的编辑；生成的回答仍可查看。');
          return;
        }
        if (deps.validateResult && !await deps.validateResult(result)) throw new Error('本地题库已变化，请重新查询答案。');
        if (!taskCurrent(task)) return;
        task.writing = true;
        const writeResult = await deps.writeAnswer({ question, expectedVersion: initial.version, text: answer });
        if (!taskCurrent(task)) return;
        if (!writeResult.ok) throw new Error(writeResult.error ?? '未能填入答题框，生成的回答已保留。');
        filled.add(currentToken);
        active = undefined;
        publish({ phase: 'filled', message: '已填入并核对答题内容。发送答案及进入下一题由你操作。', canConfirmReplace: false });
      } catch (error) {
        if (!taskCurrent(task)) return;
        active = undefined;
        publish({
          phase: 'error', canConfirmReplace: false,
          message: error instanceof Error ? error.message.slice(0, 240) : '生成失败，请检查 API 配置后手动重试。',
        });
      }
    } catch {
      if (!disposed && ownRevision === revision && state.running) {
        attempted.add(currentToken);
        publish({ phase: 'error', message: '无法读取 API 配置或编辑器状态，请手动重试。', canConfirmReplace: false });
      }
    } finally {
      evaluating = false;
    }
  }

  const Observer = (win as Window & typeof globalThis).MutationObserver;
  const chatObserver = new Observer(() => inspect(true));
  function refreshMount(): void {
    const next = deps.document.querySelector('#realApp #chatScroll');
    if (next === mountedChat) return;
    chatObserver.disconnect();
    mountedChat = next;
    if (next) chatObserver.observe(next, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-busy', 'aria-hidden'],
    });
    inspect(true);
  }
  // This observer only tracks mounting/replacement. Floating UI changes never schedule work.
  const mountObserver = new Observer(refreshMount);
  mountObserver.observe(deps.document.documentElement ?? deps.document, { childList: true, subtree: true });
  refreshMount();
  inspect();

  const poll = setInterval(() => {
    if (disposed || !state.running || polling) return;
    if (!deps.isEnabled()) { stop(); return; }
    inspect();
    const task = active;
    if (!task || task.writing) return;
    polling = true;
    void deps.readAnswer().then((value) => {
      if (taskCurrent(task) && !task.writing && value.ready && value.version !== task.snapshot.version) {
        blockForEdit('检测到你正在编辑答题框，已取消本次生成。');
      }
    }).catch(() => {
      if (taskCurrent(task)) {
        cancel();
        publish({ phase: 'error', message: '无法核对编辑器状态，已取消本次生成。', canConfirmReplace: false });
      }
    }).finally(() => { polling = false; });
  }, EDITOR_POLL_MS);

  function start(): void {
    if (disposed || state.running) return;
    if (!deps.isEnabled()) {
      publish({ phase: 'paused', message: 'AI 作答功能已关闭，请在设置页启用。', canConfirmReplace: false });
      return;
    }
    publish({ running: true, phase: 'waiting', message: '正在检测当前简答题。', canConfirmReplace: false });
    inspect();
    // A missing configuration or editor error may be fixed before another start.
    if (state.question && !filled.has(token) && state.phase !== 'blocked') {
      attempted.delete(token);
      schedule();
    }
  }

  function stop(): void {
    cancel();
    publish({ running: false, phase: 'paused', message: '已暂停自动填入。', canConfirmReplace: false });
  }

  win.addEventListener('pagehide', stop);

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      listener(getState());
      return () => { listeners.delete(listener); };
    },
    start, stop,
    setMode(mode) {
      if (mode !== 'fill' && mode !== 'search') return;
      cancel(); publish({ mode, running: false, phase: reference ? 'searched' : 'paused', message: mode === 'search' ? '只搜题模式，点击开始获取参考答案。' : '自动填写模式，点击开始后处理。' });
    },
    applyResult(replace = false) {
      const cached = reference;
      if (!cached || evaluating || active || state.running || !deps.isEnabled() || !sameQuestion(cached.question)) return;
      cancel(); const ownRevision = revision; evaluating = true;
      void (async () => {
        try {
          const current = await deps.readAnswer();
          if (disposed || revision !== ownRevision || !sameQuestion(cached.question) || !deps.isEnabled()) return;
          if (!current.ready || current.version !== cached.snapshot.version) throw new Error('答题框已变化，请重新查询；保留了你的编辑。');
          if (current.hasContent && !replace) throw new Error('答题框已有内容，需要明确确认覆盖。');
          if (deps.validateResult && !await deps.validateResult(cached.result)) throw new Error('本地题库已变化，请重新查询。');
          if (disposed || revision !== ownRevision || !sameQuestion(cached.question) || !deps.isEnabled()) return;
          const result = await deps.writeAnswer({ question: cached.question, expectedVersion: current.version, text: cached.result.text });
          if (disposed || revision !== ownRevision) return;
          if (!result.ok) throw new Error(result.error ?? '填写未成功，参考答案已保留。');
          filled.add(identity(cached.question)); publish({ phase: 'filled', message: '参考答案已填入并回读；发送及下一题由你操作。' });
        } catch (e) { if (!disposed && ownRevision === revision) publish({ phase: 'error', message: e instanceof Error ? e.message : '填写失败，参考答案已保留。' }); }
        finally { evaluating = false; }
      })();
    },
    confirmReplace() {
      if (!state.canConfirmReplace || !state.question || !sameQuestion(state.question) || !deps.isEnabled()) return;
      clearTimer();
      publish({ running: true, canConfirmReplace: false });
      void evaluate(true);
    },
    retry() {
      if (disposed || active || evaluating || !deps.isEnabled()) return;
      cancel();
      attempted.delete(token);
      filled.delete(token);
      publish({ running: true, phase: 'waiting', message: '准备重新检测并生成当前题目。', canConfirmReplace: false });
      inspect();
      schedule();
    },
    settingsChanged() {
      cancel();
      reference = undefined;
      publish({ running: false, phase: 'paused', canConfirmReplace: false,
        message: deps.isEnabled() ? '设置已更新，点击开始继续。' : 'AI 作答功能已关闭。' });
      inspect();
    },
    dispose() {
      cancel();
      disposed = true;
      clearInterval(poll);
      chatObserver.disconnect();
      mountObserver.disconnect();
      win.removeEventListener('pagehide', stop);
      listeners.clear();
    },
  };
}
