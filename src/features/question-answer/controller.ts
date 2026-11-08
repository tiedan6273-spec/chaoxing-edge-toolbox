import type { StudyTarget, StudyTaskOutcome } from '../chapter-study/types';
import type { AnswerRuntime } from './client';
import type { AnswerFrameSnapshot } from './background';
import { planAnswerSource } from './source-status';
import { normalizeAnswer } from './normalize';
import {
  createReviewQuestion, isCompleteApplicableAnswer, sameApplicableAnswer,
  type QuestionReviewRequest, type QuestionReviewResult,
} from './review';
import type { PacingWait } from '../answer-pacing/scheduler';
import type { HistoryClient } from '../activity/history';
import { digest } from '../activity/types';
import type {
  AnswerControlSnapshot, AnswerPageCommand, AnswerPaper, AnswerResult, AnswerRow, AnswerSourceMode, AnswerSourcesStatus, ApplicableAnswer, CompletionPolicy,
  ImportedAnswer, PreparedQuestion, QuestionAnswerController, QuestionAnswerState, QuestionTarget, AnswerMode,
} from './types';

interface Dependencies {
  runtime: AnswerRuntime; isEnabled(): boolean;
  canPreview?(): boolean;
  getSources(): Promise<AnswerSourcesStatus>;
  saveSource(source: AnswerSourceMode): Promise<void>;
  generate(prepared: PreparedQuestion, source: AnswerSourceMode, signal: AbortSignal, progress: (text: string) => void, status?: (text: string) => void): Promise<AnswerResult>;
  review?(request: QuestionReviewRequest, signal: AbortSignal, progress: (text: string) => void, status?: (text: string) => void): Promise<QuestionReviewResult>;
  waitBeforeFill?: PacingWait;
  watchInterval?: number;
  history?: HistoryClient;
}
export interface ChapterAnswerController extends QuestionAnswerController {
  runChapter(target: StudyTarget, signal: AbortSignal, policy: CompletionPolicy): Promise<StudyTaskOutcome>;
}
interface Run {
  abort: AbortController; chapter?: StudyTarget; policy?: CompletionPolicy; onlyId?: string; replace?: boolean;
  checkedVersions?: Map<string, string>;
  source?: AnswerSourceMode;
  invalidated?: boolean;
  imported?: Map<string, ImportedAnswer>;
  importSource?: 'import' | 'local-bank';
  kind?: 'answer' | 'review';
  forceReview?: boolean;
  mode?: AnswerMode; ids?: string[]; fresh?: boolean; useResult?: boolean;
}
const identity = (target: QuestionTarget) => ({ documentKey: target.documentKey, scopeKey: target.scopeKey, key: target.question.key, fingerprint: target.question.fingerprint });
const rowId = (target: QuestionTarget) => `${target.frameId}:${target.documentId ?? ''}:${target.documentKey}:${target.scopeKey}:${target.question.key}`;
const cancelled = () => new DOMException('答题已暂停。', 'AbortError');

/** The top page owns one serial queue shared by manual actions and chapter learning. */
export function createQuestionAnswerController(deps: Dependencies): ChapterAnswerController {
  const canPreview = deps.canPreview ?? deps.isEnabled;
  let state: QuestionAnswerState = {
    phase: 'idle', running: false, source: null, rows: [], followProgress: true, mode: 'fill', range: 'all',
    message: '打开测验、作业或考试后，点击开始答题。', reviewing: false,
  };
  let run: Run | undefined;
  let disposed = false;
  let sourcesRevision = 0;
  let previewRevision = 0;
  let previewTask: Promise<void> | undefined;
  let previewRequested = false;
  const results = new Map<string, { fingerprint: string; source: AnswerSourceMode; controlVersion: string; result: AnswerResult }>();
  const reviewCache = new Map<string, QuestionReviewResult>();
  let sourceSignature = '';
  let lastRange: { mode: AnswerMode; range: QuestionAnswerState['range']; ids: string[] } | undefined;
  let historyRevision = 0;
  const listeners = new Set<(state: QuestionAnswerState) => void>();
  const getState = (): QuestionAnswerState => structuredClone(state);
  const emit = (update: Partial<QuestionAnswerState>) => {
    if (disposed) return;
    state = { ...state, ...update };
    for (const listener of listeners) listener(getState());
  };
  const check = (current: Run) => {
    if (disposed || run !== current || current.abort.signal.aborted || !deps.isEnabled()) throw cancelled();
  };
  const updateRow = (id: string, patch: Partial<AnswerRow>) => emit({ rows: state.rows.map(row => row.id === id ? { ...row, ...patch } : row) });
  function invalidateResults(): void {
    reviewCache.clear();
    emit({ reviewAvailable: false, reviewProgress: undefined, rows: state.rows.map(row => ({ ...row, review: undefined })) });
    results.clear();
    emit({ rows: state.rows.map(row => ({ ...row, resultApplicable: false })) });
  }
  function publishScope(scope: AnswerFrameSnapshot[]): AnswerRow[] {
    const previous = new Map(state.rows.map(row => [row.id, row]));
    const rows: AnswerRow[] = [];
    const papers: AnswerPaper[] = scope.map(frame => {
      const { snapshot } = frame;
      const rowIds = snapshot.questions.map(question => {
        const target: QuestionTarget = { frameId: frame.frameId, documentId: frame.documentId, documentKey: snapshot.documentKey, scopeKey: snapshot.scopeKey, question };
        const id = rowId(target);
        const old = previous.get(id);
        const retained = old?.target.question.fingerprint === question.fingerprint ? old : undefined;
        rows.push({ id, target, phase: retained?.phase ?? (question.supported ? 'pending' : 'unsupported'),
          message: retained?.message ?? (question.supported ? '等待处理' : question.reason || '当前题型暂不支持。'),
          text: retained?.text ?? '', source: retained?.source, tags: retained?.tags,
          resultAnswer: retained?.resultAnswer, resultApplicable: retained?.resultApplicable, currentAnswer: retained?.currentAnswer, readOnly: snapshot.complete || !question.supported,
          review: snapshot.complete ? undefined : retained?.review });
        return id;
      });
      return { id: `${frame.frameId}:${frame.documentId ?? ''}:${snapshot.documentKey}:${snapshot.scopeKey}`,
        frameId: frame.frameId, documentId: frame.documentId, documentKey: snapshot.documentKey, scopeKey: snapshot.scopeKey,
        scene: snapshot.scene, allLoaded: snapshot.allLoaded, complete: snapshot.complete, rowIds };
    });
    const samePaper = JSON.stringify([state.papers?.map(paper => [paper.id, paper.rowIds]), state.rows.map(row => row.target.question.fingerprint)])
      === JSON.stringify([papers.map(paper => [paper.id, paper.rowIds]), rows.map(row => row.target.question.fingerprint)]);
    for (const [id, cached] of results) if (!rows.some(row => row.id === id && row.target.question.fingerprint === cached.fingerprint)) results.delete(id);
    emit({ rows, papers, previewStale: false, selectedId: rows.some(row => row.id === state.selectedId) ? state.selectedId : rows[0]?.id,
      activeId: samePaper && rows.some(row => row.id === state.activeId) ? state.activeId : undefined,
      followProgress: samePaper ? state.followProgress : true,
      completion: samePaper ? state.completion : undefined,
      ...(!samePaper ? { reviewAvailable: false, reviewProgress: undefined } : {}),
      ...(!run && scope.length && scope.every(frame => frame.snapshot.complete) ? { mode: 'search' as const } : {}) });
    return rows;
  }
  function updateControl(row: AnswerRow, control: AnswerControlSnapshot, preservePhase = false): void {
    const completed = state.papers?.some(paper => paper.complete && paper.rowIds.includes(row.id));
    const readOnly = Boolean(completed || !control.ready);
    const retained = state.rows.find(item => item.id === row.id);
    const stillFilled = retained?.phase === 'filled' && JSON.stringify(retained.currentAnswer) === JSON.stringify(control.answer);
    const answerChanged = retained?.currentAnswer !== undefined && !sameApplicableAnswer(retained.currentAnswer, control.answer);
    if (answerChanged) emit({ reviewAvailable: false, reviewProgress: undefined });
    if (answerChanged && state.completion === 'saved') emit({ completion: 'unconfirmed' });
    updateRow(row.id, { currentAnswer: control.answer, readOnly,
      review: answerChanged || !control.ready || completed ? undefined : retained?.review,
      ...(!preservePhase ? { phase: retained?.phase === 'searched' && retained.resultAnswer ? 'searched' : control.hasContent ? (stillFilled ? 'filled' : control.complete ? 'existing' : 'needs-review')
        : !row.target.question.supported ? 'unsupported' : 'pending',
      message: completed ? '平台已完成，本页仅供阅览。' : readOnly ? control.error || '当前题目只可阅览。'
        : control.hasContent ? control.complete ? '保留页面已有答案。' : '页面已有部分答案，请检查。' : '尚未填写。' } : {}) });
  }
  async function readPreviewRows(rows: AnswerRow[], signal: AbortSignal, valid: () => boolean): Promise<void> {
    for (const row of rows) {
      if (!valid()) return;
      try {
        const result = await deps.runtime.page(row.target, { action: 'read', ...identity(row.target) }, signal);
        if (!valid()) return;
        if (!result.ok || !result.control) throw new Error(result.error || '无法读取页面答案。');
        updateControl(row, result.control);
      } catch (error) {
        if (!valid()) return;
        updateRow(row.id, { readOnly: true, currentAnswer: undefined, message: error instanceof Error ? error.message : '无法读取页面答案，请刷新阅览。' });
      }
    }
  }
  async function readPreview(revision: number): Promise<void> {
    // Aborting a transport read cancels the shared page queue. Ignore stale preview replies instead.
    const signal = new AbortController().signal;
    const valid = () => !disposed && !run && canPreview() && revision === previewRevision;
    emit({ previewing: true });
    try {
      const frames = await deps.runtime.scan(signal);
      if (!valid()) return;
      const rows = publishScope(frames.filter(frame => frame.snapshot.scene !== 'unsupported'));
      await readPreviewRows(rows, signal, valid);
      if (valid() && deps.history) {
        const revision = ++historyRevision;
        try {
          const records = await deps.history.load(rows.map(row => row.target.question));
          if (valid() && revision === historyRevision) emit({ history: { available: records.filter(record => !rows[record.index]?.resultAnswer).length, busy: false, message: '记录仅保存在本机；恢复不会填写页面。' } });
        } catch { if (valid() && revision === historyRevision) emit({ history: { available: 0, busy: false, message: '历史读取失败，可重新识别；当前结果仍可导出。' } }); }
      }
      if (valid()) emit({ message: rows.length ? `已读取当前加载的 ${rows.length} 题，可先阅览再开始答题。` : '未识别到已加载题目，请进入测验或作业后刷新阅览。' });
    } catch (error) {
      if (valid()) emit({ rows: state.rows.map(row => ({ ...row, readOnly: true })), message: error instanceof Error ? error.message : '题目阅览失败，请刷新。' });
    } finally { if (valid()) emit({ previewing: false }); }
  }
  function preview(): void {
    if (disposed || run || state.history?.busy || !canPreview()) return;
    ++previewRevision;
    previewRequested = true;
    emit({ previewing: true });
    if (previewTask) return;
    const task = (async () => {
      while (previewRequested && !disposed && !run && canPreview()) {
        previewRequested = false;
        await readPreview(previewRevision);
      }
    })();
    previewTask = task;
    void task.finally(() => {
      if (previewTask !== task) return;
      previewTask = undefined;
      if (!disposed && !run) emit({ previewing: false });
    });
  }
  async function refreshSources(): Promise<AnswerSourcesStatus | undefined> {
    if (disposed) return;
    const revision = ++sourcesRevision;
    emit({ sources: undefined, sourcesError: undefined });
    try {
      const sources = await deps.getSources();
      if (disposed || revision !== sourcesRevision) return;
      const signature = JSON.stringify(sources);
      if (sourceSignature && signature !== sourceSignature) invalidateResults();
      sourceSignature = signature;
      emit({ sources, source: sources.selection });
      return sources;
    } catch {
      if (!disposed && revision === sourcesRevision) emit({ sourcesError: '无法读取答题来源配置，请点击“重新检查”；若仍失败，请重新加载扩展并刷新页面。' });
      return;
    }
  }
  const page = async (current: Run, target: QuestionTarget, command: AnswerPageCommand) => {
    check(current);
    const result = await deps.runtime.page(target, command, current.abort.signal);
    check(current);
    if (!result.ok) throw new Error(result.error || '题目页面操作失败。');
    return result;
  };
  const read = async (current: Run, target: QuestionTarget): Promise<AnswerControlSnapshot> => {
    const response = await page(current, target, { action: 'read', ...identity(target) });
    if (!response.control) throw new Error('无法读取本题填写状态。');
    return response.control;
  };

  async function answerOne(current: Run, row: AnswerRow): Promise<void> {
    check(current);
    const startedAt = Date.now();
    const source = current.source;
    if (!source && !current.imported) throw new Error('请先选择答题来源。');
    const target = row.target;
    const searchOnly = current.mode === 'search';
    if (!target.question.supported) { updateRow(row.id, { phase: 'unsupported', message: target.question.reason || '当前题目结构暂不支持，未填写。' }); return; }
    const before = await read(current, target);
    updateControl(row, before, true);
    if (!searchOnly && !before.ready) { updateRow(row.id, { phase: 'unsupported', message: before.error || '答题控件尚未就绪。' }); return; }
    current.checkedVersions?.set(row.id, before.version);
    if (!searchOnly && before.hasContent && !current.replace) {
      updateRow(row.id, { phase: before.complete ? 'existing' : 'needs-review', message: before.complete ? '保留已有答案。' : '本题已有部分答案，保留原内容；请检查或确认覆盖。' });
      return;
    }
    if (!current.imported && source && state.sources) {
      const plan = planAnswerSource(source, state.sources, Boolean(target.question.textRecognition), target.question.kind === 'program');
      if (!plan.first) { updateRow(row.id, { phase: 'needs-review', message: plan.message }); return; }
    }
    const cached = results.get(row.id);
    const reusable = !current.fresh && cached && cached.source === source && cached.fingerprint === target.question.fingerprint ? cached.result : undefined;
    if (current.useResult && !reusable) throw new Error('参考答案已失效，请重新搜题后应用。');
    if (current.useResult && cached?.controlVersion !== before.version) throw new Error('搜题后页面答案已变化，请重新读取并搜索，未覆盖你的修改。');
    if (current.fresh) results.delete(row.id);
    updateRow(row.id, { phase: 'querying', message: reusable ? '正在核对已获取的答案…' : '正在获取答案…',
      ...(!reusable ? { text: '', source: undefined, tags: undefined, resultAnswer: undefined, resultApplicable: false } : {}) });
    let monitoring = false;
    let watching = true;
    let changed: Error | undefined;
    const watch = setInterval(() => {
      if (!watching || monitoring || current.abort.signal.aborted || run !== current) return;
      monitoring = true;
      void read(current, target).then(snapshot => {
        if (!watching) return;
        if (!searchOnly && (!snapshot.ready || snapshot.version !== before.version)) { updateControl(row, snapshot, true); throw new Error('题目或已有答案已变化，已暂停，未覆盖你的修改。'); }
      }).catch(error => {
        if (watching && !current.abort.signal.aborted && run === current) {
          changed = error instanceof Error ? error : new Error('题目已变化。');
          current.abort.abort(); deps.runtime.cancel();
        }
      }).finally(() => { monitoring = false; });
    }, deps.watchInterval ?? 800);
    try {
      let result: AnswerResult;
      if (reusable) result = structuredClone(reusable);
      else if (current.imported) {
        const imported = current.imported.get(row.id);
        const answer = imported && normalizeAnswer(target.question, imported.answer);
        if (!answer) throw new Error('导入答案未通过题型与选项核对，未填写。');
        result = { status: 'answer', source: current.importSource ?? 'import', text: JSON.stringify(answer), answer };
      } else {
        const prepared: PreparedQuestion = target.question.images.length
          ? (await page(current, target, { action: 'images', ...identity(target) })).prepared!
          : { question: structuredClone(target.question), images: [], suggestionTitle: '', suggestionOptions: '' };
        if (!prepared) throw new Error('图片未能完整读取，本题未请求答案。');
        const request = { ...prepared, question: { ...prepared.question } };
        delete request.question.reviewData;
        result = await deps.generate(request, source!, current.abort.signal, text => {
          if (run === current && !current.abort.signal.aborted) updateRow(row.id, { text });
        }, message => { if (run === current && !current.abort.signal.aborted) updateRow(row.id, { message }); });
      }
      check(current);
      if (result.status === 'answer' && result.answer && !current.imported) results.set(row.id, { fingerprint: target.question.fingerprint, source: source!, controlVersion: before.version, result: structuredClone(result) });
      updateRow(row.id, { text: result.text, source: result.source, tags: result.tags,
        resultAnswer: result.status === 'answer' && result.answer ? structuredClone(result.answer) : undefined,
        resultApplicable: result.status === 'answer' && Boolean(result.answer) });
      if (result.status !== 'answer' || !result.answer) {
        updateRow(row.id, { phase: 'needs-review', message: result.message || '没有可可靠填写的答案，请手动处理。' });
        return;
      }
      if (searchOnly) {
        const live = await read(current, target);
        const saved = results.get(row.id); if (saved) saved.controlVersion = live.version;
        updateControl(row, live, true);
        updateRow(row.id, { phase: 'searched', message: result.message || '已获取参考答案；页面答案未修改。' });
        return;
      }
      await deps.waitBeforeFill?.(startedAt, current.abort.signal, message => updateRow(row.id, { message }));
      check(current);
      const live = await read(current, target);
      updateControl(row, live, true);
      if (!live.ready || live.version !== before.version) throw new Error('生成期间题目或已有答案发生变化，未覆盖。');
      // Stop polling before our own mutation; the page adapter performs the final compare-and-write.
      watching = false;
      clearInterval(watch);
      const written = result.localProof ? await deps.runtime.page(target, {
        action: 'write', ...identity(target), expectedVersion: before.version, answer: result.answer, replace: Boolean(current.replace),
      }, current.abort.signal, result.localProof) : await page(current, target, {
        action: 'write', ...identity(target), expectedVersion: before.version, answer: result.answer, replace: Boolean(current.replace),
      });
      check(current);
      if (!written.ok || !written.control?.complete) throw new Error(written.error || '填写后的状态未通过核对，请检查本题。');
      current.checkedVersions?.set(row.id, written.control.version);
      updateRow(row.id, {
        phase: 'filled', currentAnswer: written.control.answer, readOnly: false,
        ...(!sameApplicableAnswer(before.answer, written.control.answer) ? { review: undefined } : {}),
        message: written.warning ? `已填写并核对。${written.warning}` : result.message ? `已填写并核对。${result.message}` : '已填写并核对。',
      });
    } catch (error) {
      throw changed ?? error;
    } finally { watching = false; clearInterval(watch); }
  }

  async function executeReview(current: Run): Promise<void> {
    if (run) throw new Error('当前已有答题任务，请先暂停。');
    if (state.sourceSaving) throw new Error('正在保存答题来源，请稍后继续。');
    if (!deps.isEnabled()) throw new Error('请先开启批量答题功能。');
    const review = deps.review;
    if (!review) throw new Error('当前版本尚未接入整卷复检服务。');
    ++previewRevision;
    previewRequested = false;
    run = current;
    emit({
      running: true, reviewing: true, previewing: false, followProgress: true, completion: undefined,
      phase: 'scanning', message: '步骤 1/3 · 读取页面答案（本地读取）…', reviewProgress: '步骤 1/3 · 读取页面答案…',
      reviewError: undefined, rows: state.rows.map(row => ({ ...row, review: undefined })),
    });
    try {
      await previewTask;
      check(current);
      const frames = await deps.runtime.scan(current.abort.signal);
      check(current);
      const scope = frames.filter(frame => frame.snapshot.scene !== 'unsupported');
      if (scope.length !== 1) throw new Error(scope.length ? '当前页面包含多个题目范围，无法进行单一整卷复检。' : '未读取到可复检的整卷题目。');
      const frame = scope[0];
      if (!frame.snapshot.allLoaded) {
        const saveLabel = frame.snapshot.scene === 'chapter-test' ? '保存' : '暂时保存';
        throw new Error(`尚未核实整卷题量或页面仍有分页，不能发送整卷复检。请先在页面点「${saveLabel}」再刷新阅览。`);
      }
      if (frame.snapshot.complete) throw new Error('平台已显示本卷完成，不能再编辑复检；请核对页面状态。');
      const rows = publishScope([frame]);
      if (!rows.length) throw new Error('整卷没有可复检题目。');
      const unsupported = rows.filter(row => !row.target.question.supported);
      if (unsupported.length) throw new Error(`仍有 ${unsupported.length} 道题不支持复检：第 ${unsupported.map(row => row.target.question.number).join('、')} 题。`);
      if (rows.some(row => row.target.question.textRecognition?.status === 'pending')) throw new Error('仍有题目文字正在识别，请稍候刷新阅览后再复检。');

      const sources = await refreshSources();
      check(current);
      if (!sources) throw new Error(state.sourcesError || '无法读取 AI 复检配置。');
      if (!sources.ai.enabled) throw new Error('AI 作答功能未启用，不能进行整卷复检。');
      if (!sources.ai.configured || !sources.ai.authorized) throw new Error('尚未配置并授权 AI 接口，不能进行整卷复检。');
      if (rows.some(row => row.target.question.images.length) && sources.ai.supportsImages !== true) {
        throw new Error('整卷包含图片题，但当前模型未启用图片输入能力；请先在 API 设置中确认模型能力。');
      }

      emit({ phase: 'running', message: '步骤 1/3 · 本地读取当前答案；随后只发送一次整卷请求。', reviewProgress: `本地读取 0/${rows.length}` });
      const baseline = new Map<string, ApplicableAnswer>();
      for (const [index, row] of rows.entries()) {
        check(current);
        emit({ reviewProgress: `步骤 1/3 · 本地读取 ${index + 1}/${rows.length}` });
        const control = await read(current, row.target);
        updateControl(row, control, true);
        if (!control.ready) throw new Error(`第 ${row.target.question.number} 题答题控件未就绪：${control.error || '请检查页面。'}`);
        if (!control.complete || !isCompleteApplicableAnswer(row.target.question, control.answer)) {
          throw new Error(`仍有题目未完整作答：第 ${row.target.question.number} 题。请完成整卷后重试。`);
        }
        baseline.set(row.id, structuredClone(control.answer));
      }

      const items: QuestionReviewRequest['items'] = [];
      for (const [index, row] of rows.entries()) {
        check(current);
        let images: string[] = [];
        if (row.target.question.images.length) {
          emit({ reviewProgress: `正在读取图片 ${index + 1}/${rows.length}` });
          const prepared = (await page(current, row.target, { action: 'images', ...identity(row.target) })).prepared;
          if (!prepared || prepared.images.length !== row.target.question.images.length) {
            throw new Error(`第 ${row.target.question.number} 题图片未能完整读取，整卷未发送复检。`);
          }
          images = prepared.images;
        }
        const currentAnswer = baseline.get(row.id)!;
        items.push({
          questionId: `q-${index + 1}`,
          question: createReviewQuestion(row.target.question),
          currentAnswer: structuredClone(currentAnswer),
          images,
        });
      }

      const request: QuestionReviewRequest = { batchId: crypto.randomUUID(), items };
      const cacheKey = await digest([rows.map(row => [row.id, row.target.question.fingerprint]), items]);
      check(current);
      const cached = current.forceReview ? undefined : reviewCache.get(cacheKey);
      emit({ reviewProgress: cached ? '答案未变，正在复用本页复检结果…' : `步骤 2/3 · 一次性请求 ${rows.length} 题的 AI 复检…`, message: cached ? '正在读取已完成的复检，无新增 AI 请求。' : 'AI 复检请求中；可随时停止。' });
      const result = cached ?? await review(request, current.abort.signal, text => {
        if (run === current && !current.abort.signal.aborted) emit({ reviewProgress: `步骤 2/3 · 接收 AI 结果（同一请求，${text.length} 字符）…` });
      }, text => {
        if (run === current && !current.abort.signal.aborted) emit({ reviewProgress: text });
      });
      check(current);

      // A model call can take minutes. Re-read every answer before publishing any finding.
      for (const [index, row] of rows.entries()) {
        emit({ reviewProgress: `步骤 3/3 · 本地确认页面未变化 ${index + 1}/${rows.length}` });
        const control = await read(current, row.target);
        updateControl(row, control, true);
        const before = baseline.get(row.id)!;
        if (!control.ready || !control.complete || !sameApplicableAnswer(control.answer, before)) {
          throw new Error('复检期间页面答案已变化，整卷结果已丢弃；请确认后重新复检。');
        }
      }
      check(current);
      reviewCache.delete(cacheKey); reviewCache.set(cacheKey, structuredClone(result));
      if (reviewCache.size > 3) reviewCache.delete(reviewCache.keys().next().value!);
      const outcomes = new Map(result.items.map(item => [item.questionId, item]));
      const rowIds = new Map(rows.map((row, index) => [row.id, `q-${index + 1}`]));
      const suspect = result.items.filter(item => item.status === 'suspect').length;
      const uncertain = result.items.filter(item => item.status === 'uncertain').length;
      emit({
        rows: state.rows.map(row => {
          const outcome = outcomes.get(rowIds.get(row.id) ?? '');
          if (!outcome || outcome.status === 'pass') return { ...row, review: undefined };
          if (outcome.status === 'suspect') return {
            ...row,
            review: { status: 'suspect', suggestedAnswer: outcome.suggestedAnswer, reason: outcome.reason! },
          };
          return { ...row, review: { status: 'uncertain', reason: outcome.reason! } };
        }),
        phase: 'complete', message: suspect || uncertain
          ? `AI 整卷复检完成：${suspect} 道答案不一致，${uncertain} 道需人工确认。页面答案未被修改。`
          : 'AI 整卷复检完成：未发现需要标记的题目。页面答案未被修改。',
        reviewProgress: `已复检 ${rows.length} 题 · ${cached ? '复用结果，无新增请求' : '本次 AI 请求 1 次'}`,
        reviewAvailable: true, reviewError: undefined,
      });
    } catch (error) {
      const message = current.invalidated ? '题目页面已更换，请重新读取题目。' : error instanceof Error ? error.message : '整卷复检失败，请检查页面。';
      emit({
        phase: current.abort.signal.aborted ? 'paused' : 'error',
        message,
        reviewProgress: undefined,
        reviewError: current.abort.signal.aborted ? undefined : message,
        rows: state.rows.map(row => ({ ...row, review: undefined })),
      });
    } finally {
      if (run === current) {
        run = undefined;
        current.abort.abort();
        deps.runtime.cancel();
        emit({ running: false, reviewing: false });
      }
    }
  }

  async function execute(current: Run): Promise<StudyTaskOutcome | undefined> {
    if (run) throw new Error('当前已有答题任务，请先暂停。');
    if (state.sourceSaving) throw new Error('正在保存答题来源，请稍后继续。');
    if (!deps.isEnabled()) throw new Error('请先开启批量答题功能。');
    ++previewRevision;
    previewRequested = false;
    run = current;
    current.checkedVersions = new Map();
    emit({
      running: true, reviewing: false, previewing: false, followProgress: true, completion: undefined,
      ...(current.mode ? { mode: current.mode } : {}),
      phase: 'scanning', message: '正在读取当前页面各题目框架…', reviewProgress: undefined, reviewError: undefined,
    });
    let activeId: string | undefined;
    try {
      // Let earlier transport reads (including their timeout cleanup) settle before any answer work.
      await previewTask;
      check(current);
      const frames = await deps.runtime.scan(current.abort.signal);
      check(current);
      const scope = frames.filter(frame => frame.snapshot.scene !== 'unsupported'
        && (!current.chapter || (frame.frameId === current.chapter.frameId && frame.documentId === current.chapter.documentId && frame.snapshot.scene === 'chapter-test')));
      const previous = new Map(state.rows.map(row => [row.id, row]));
      const allRows = publishScope(scope);
      if (current.imported) {
        for (const [id, entry] of current.imported) {
          const live = allRows.find(row => row.id === id);
          if (!live || live.readOnly || live.target.question.fingerprint !== entry.target.question.fingerprint) {
            throw new Error('导入答案对应的题目已变化、完成或不在当前页面，请重新读取并匹配。');
          }
        }
      }
      if (current.mode !== 'search' && scope.length && scope.every(frame => frame.snapshot.complete)) {
        await readPreviewRows(allRows, current.abort.signal, () => run === current && !current.abort.signal.aborted);
        check(current);
        emit({ phase: 'complete', message: '平台显示当前题目已完成，无需重新填写。' });
        return { status: 'acted', message: '章节测验已完成。' };
      }
      const rows = allRows.filter(row => current.mode === 'search' || !scope.find(frame => frame.frameId === row.target.frameId && frame.documentId === row.target.documentId)?.snapshot.complete);
      if (!rows.length) throw new Error('没有识别到可用题目子页面。请等待内容加载；未知页面模板暂不支持。');
      if (current.ids?.some(id => !allRows.some(row => row.id === id && row.target.question.fingerprint === previous.get(id)?.target.question.fingerprint))) throw new Error('所选范围的题目已变化，请重新识别并选择起点。');
      if (current.onlyId && !rows.some(row => row.id === current.onlyId && row.target.question.fingerprint === previous.get(row.id)?.target.question.fingerprint)) throw new Error('目标题目已变化，请重新开始读取。');
      if (!current.imported) {
        const sources = await refreshSources();
        check(current);
        if (!sources) throw new Error(state.sourcesError || '答题来源配置已变化，请重新开始。');
        const programOnly = rows.every(row => row.target.question.kind === 'program');
        const regularPlan = planAnswerSource(state.source, sources, false, programOnly);
        const plan = regularPlan.first ? regularPlan : rows.some(row => row.target.question.supported && row.target.question.textRecognition)
          ? planAnswerSource(state.source, sources, true, programOnly) : regularPlan;
        if (!plan.first || !sources.selection) {
          await readPreviewRows(allRows, current.abort.signal, () => run === current && !current.abort.signal.aborted);
          check(current);
          throw new Error(plan.message);
        }
        current.source = sources.selection;
      }
      emit({ phase: 'running', message: current.mode === 'search' ? '正在逐题搜索参考答案；不会填写或交卷。' : current.imported ? '正在填写已核对的导入答案；已有内容默认保留。' : '正在逐题获取并填写答案；可随时暂停。' });
      for (const row of rows) {
        if ((current.ids && !current.ids.includes(row.id)) || (current.onlyId && row.id !== current.onlyId) || (current.imported && !current.imported.has(row.id))) {
          const old = previous.get(row.id);
          if (old?.target.question.fingerprint === row.target.question.fingerprint) updateRow(row.id, old);
          continue;
        }
        check(current); activeId = row.id;
        emit({ activeId: row.id, ...(state.followProgress ? { selectedId: row.id } : {}) });
        await answerOne(current, row);
        activeId = undefined;
      }
      check(current);
      if (!current.chapter) { emit({ phase: 'complete', message: current.mode === 'search' ? '所选范围搜题结束；参考答案可导出，页面未被填写。' : '本轮填写结束，请检查答案后自行保存或提交。' }); return; }
      if (current.policy === 'stay') {
        emit({ phase: 'complete', message: '章节测验填写结束，已停留等待检查。' });
        return { status: 'attention', message: '章节测验已填写，请检查后手动保存或提交。' };
      }
      const frame = scope[0];
      if (scope.length !== 1 || !frame) throw new Error('章节测验范围不唯一，无法自动保存或提交。');
      if (current.policy === 'submit' && (!frame.snapshot.allLoaded || !frame.snapshot.canSubmit
          || state.rows.some(row => !['filled', 'existing'].includes(row.phase)))) throw new Error('仍有未处理题目、分页或无法核对的内容，已停留，未自动提交。');
      if (current.policy === 'save' && !frame.snapshot.canSave) throw new Error('当前页面没有已支持的保存入口，已停留避免丢失答案。');
      const expected: Array<{ key: string; fingerprint: string; version: string }> = [];
      for (const row of state.rows) {
        const control = await read(current, row.target);
        updateControl(row, control, true);
        if (!control.ready) throw new Error('题目控件未就绪，已停留，未保存或提交。');
        const checkedVersion = current.checkedVersions.get(row.id);
        if (checkedVersion !== undefined && control.version !== checkedVersion) throw new Error('填写后答案发生变化，已停留，请检查后自行保存或提交。');
        if (current.policy === 'submit' && !control.complete) throw new Error('仍有题目未完整填写，未自动提交。');
        expected.push({ key: row.target.question.key, fingerprint: row.target.question.fingerprint, version: control.version });
      }
      emit({ completion: current.policy === 'submit' ? 'submitting' : 'saving', message: current.policy === 'submit' ? '正在提交并等待平台确认…' : '正在保存草稿并等待平台确认…' });
      const result = await page(current, rows[0].target, {
        action: 'finish', documentKey: frame.snapshot.documentKey, scopeKey: frame.snapshot.scopeKey,
        policy: current.policy ?? 'save', expected,
      });
      if (result.outcome !== (current.policy === 'submit' ? 'submitted' : 'saved')) throw new Error('平台尚未确认操作成功，已停留检查。');
      const saved = result.outcome === 'saved';
      const message = saved ? '章节测验已保存、待提交，继续后续学习。' : '平台已确认测验提交，继续后续学习。';
      emit({ phase: 'complete', completion: saved ? 'saved' : 'submitted', message,
        ...(!saved ? { papers: state.papers?.map(paper => ({ ...paper, complete: true })),
          rows: state.rows.map(row => ({ ...row, readOnly: true })) } : {}) });
      return { status: 'acted', message, chapterIncomplete: saved };
    } catch (error) {
      const message = current.invalidated ? '题目页面已更换，请重新读取题目。' : error instanceof Error ? error.message : '答题失败，请检查页面。';
      if (state.completion === 'saving' || state.completion === 'submitting') emit({ completion: 'unconfirmed' });
      if (activeId) updateRow(activeId, { phase: current.abort.signal.aborted && message === '答题已暂停。' ? 'pending' : 'error', message });
      emit({ phase: current.abort.signal.aborted ? 'paused' : 'error', message });
      if (current.chapter) return { status: 'attention', message };
    } finally {
      if (run === current) { run = undefined; current.abort.abort(); deps.runtime.cancel(); emit({ running: false }); }
    }
  }
  const launch = (options: Partial<Run> = {}) => {
    if (run || state.sourceSaving || state.history?.busy) return;
    const current: Run = { mode: state.mode ?? 'fill', ...options, abort: new AbortController() };
    const operation = current.kind === 'review' ? executeReview(current) : execute(current);
    void operation.catch(error => {
      const message = error instanceof Error ? error.message : '无法开始答题。';
      emit({
        phase: 'error', running: false, reviewing: false, message,
        ...(current.kind === 'review' ? { reviewError: message, reviewProgress: undefined } : {}),
      });
    });
  };
  const stop = () => {
    ++historyRevision;
    const reviewing = run?.kind === 'review';
    ++previewRevision;
    previewRequested = false;
    if (run) run.abort.abort();
    deps.runtime.cancel();
    emit({
      previewing: false, phase: 'paused', reviewing: false,
      ...(state.history?.busy ? { history: { ...state.history, busy: false, message: '记录操作已停止，请重新识别。' } } : {}),
      message: reviewing ? '已停止整卷复检；页面答案未被修改。' : '已暂停；已填写内容保留。',
      ...(reviewing ? { reviewProgress: undefined, reviewError: undefined } : {}),
    });
  };
  const unsubscribeInvalidation = deps.runtime.subscribeInvalidation?.(() => {
    if (disposed) return;
    invalidateResults(); lastRange = undefined;
    ++historyRevision;
    ++previewRevision;
    previewRequested = false;
    if (run) { run.invalidated = true; stop(); }
    emit({
      rows: state.rows.map(row => ({ ...row, readOnly: true, review: undefined })),
      previewing: false, previewStale: true, reviewing: false, reviewProgress: undefined, reviewError: undefined,
      message: '题目页面已更换，请重新读取题目。',
      history: undefined,
    });
  });
  void refreshSources();
  return {
    getState,
    subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); },
    start() {
      if (state.previewStale) return;
      if (!state.rows.length) { if (!state.range || state.range === 'all') launch(); return; }
      const mode = state.mode ?? 'fill'; const range = state.range ?? 'all';
      const index = Math.max(0, state.rows.findIndex(row => row.id === state.selectedId));
      const ids = state.phase === 'paused' && lastRange?.mode === mode && lastRange.range === range ? lastRange.ids
        : (range === 'current' ? [state.rows[index]] : range === 'forward' ? state.rows.slice(index) : state.rows).map(row => row.id);
      lastRange = { mode, range, ids };
      launch({ ids });
    }, stop,
    restoreHistory() {
      if (!deps.history || disposed || run || state.previewing || state.previewStale || state.sourceSaving || state.history?.busy || !canPreview()) return;
      const revision = ++historyRevision;
      const baseline = state.rows.map(row => ({ id: row.id, fingerprint: row.target.question.fingerprint }));
      const valid = () => !disposed && !run && !state.previewStale && revision === historyRevision
        && JSON.stringify(baseline) === JSON.stringify(state.rows.map(row => ({ id: row.id, fingerprint: row.target.question.fingerprint })));
      emit({ history: { available: state.history?.available ?? 0, busy: true, message: '正在核对当前题目和历史记录…' } });
      void (async () => {
        const records = await deps.history!.load(state.rows.map(row => row.target.question));
        if (!valid()) return;
        const updates: Array<{ id: string; result: AnswerResult; control: AnswerControlSnapshot; reusable: boolean }> = [];
        for (const record of records) {
          const row = state.rows[record.index];
          if (!row || row.resultAnswer) continue;
          const response = await deps.runtime.page(row.target, { action: 'read', ...identity(row.target) }, new AbortController().signal);
          if (!valid()) return;
          if (!response.ok || !response.control) continue;
          updates.push({ id: row.id, result: record.result, control: response.control, reusable: record.reusable });
        }
        if (!valid()) return;
        for (const item of updates) {
          const row = state.rows.find(row => row.id === item.id)!;
          updateControl(row, item.control, true);
          if (item.reusable && state.source) results.set(row.id, { fingerprint: row.target.question.fingerprint, source: state.source, controlVersion: item.control.version, result: structuredClone(item.result) });
          updateRow(row.id, { phase: item.reusable ? 'searched' : 'needs-review', text: item.result.text, source: item.result.source,
            resultAnswer: item.result.answer, resultApplicable: item.reusable && Boolean(state.source),
            message: item.reusable ? '已恢复本机参考结果；页面未填写。' : '来源配置或题库已变化，历史仅供查看；请重新搜题。' });
        }
        lastRange = undefined;
        emit({ mode: 'search', range: 'all', phase: 'paused', history: { available: 0, busy: false, message: `已恢复 ${updates.length} 题；继续搜索会复用仍有效的结果。` },
          selectedId: state.rows.find(row => !results.has(row.id))?.id ?? state.rows[0]?.id,
          message: '历史结果已恢复。确认处理范围后继续搜索，或切换模式显式填写。' });
      })().catch(() => { if (valid()) emit({ history: { available: state.history?.available ?? 0, busy: false, message: '恢复失败，请重新识别后再试。' } }); });
    },
    clearHistory() {
      if (!deps.history || run || state.history?.busy) return;
      const revision = ++historyRevision;
      emit({ history: { available: state.history?.available ?? 0, busy: true, message: '正在删除当前页面历史…' } });
      void deps.history.clear().then(() => { if (!disposed && revision === historyRevision) emit({ history: { available: 0, busy: false, message: '当前页面历史已删除；页面答案和本次结果保留。' } }); })
        .catch(() => { if (!disposed && revision === historyRevision) emit({ history: { available: state.history?.available ?? 0, busy: false, message: '历史删除失败，请重试。' } }); });
    },
    setMode(mode) { if (!run && !disposed && (mode === 'fill' || mode === 'search')) { lastRange = undefined; emit({ mode }); } },
    setRange(range) { if (!run && !disposed && ['all', 'current', 'forward'].includes(range)) { lastRange = undefined; emit({ range }); } },
    search(id) { if (!state.previewStale && state.rows.some(row => row.id === id)) launch({ mode: 'search', onlyId: id, fresh: true }); },
    applyResult(id, replace = false) {
      const row = state.rows.find(row => row.id === id);
      if (!state.previewStale && row?.resultApplicable && !row.readOnly) launch({ mode: 'fill', onlyId: id, useResult: true, replace });
    },
    preview,
    reviewAnswers(force = false) {
      if (!deps.review || disposed || run || state.sourceSaving) return;
      launch({ kind: 'review', forceReview: force });
    },
    async applyImportedAnswers(entries, source = 'import') {
      if (disposed || run || state.sourceSaving || state.previewing || state.previewStale) throw new Error('请先结束当前任务并重新读取题目，再填写导入答案。');
      if (!entries.length || entries.length > 300) throw new Error('请先解析并核对 1 至 300 条可匹配答案。');
      const imported = new Map<string, ImportedAnswer>();
      for (const entry of structuredClone(entries)) {
        const question = entry.target.question;
        const answer = normalizeAnswer(question, entry.answer);
        const id = rowId(entry.target);
        if (!answer || question.images.length || question.textRecognition || imported.has(id)) throw new Error('导入答案重复或不是完整纯文本题，未填写。');
        imported.set(id, { target: entry.target, answer });
      }
      await execute({ abort: new AbortController(), imported, importSource: source });
      if (state.phase !== 'complete') throw new Error(state.message);
    },
    selectQuestion(id) { if (!disposed && state.rows.some(row => row.id === id)) emit({ selectedId: id, followProgress: false }); },
    followProgress() {
      if (disposed) return;
      emit({ followProgress: true, ...(!state.previewStale && state.rows.some(row => row.id === state.activeId) ? { selectedId: state.activeId } : {}) });
    },
    retry(id, replace = false) { if (state.rows.some(row => row.id === id)) launch({ mode: 'fill', onlyId: id, replace, fresh: true }); },
    setSource(source) {
      if (run || disposed || state.sourceSaving || !['prefer-bank', 'bank', 'ai', 'local'].includes(source)) return;
      const previous = state.source;
      invalidateResults(); lastRange = undefined;
      ++sourcesRevision;
      emit({ source, sources: undefined, sourcesError: undefined, sourceSaving: true });
      void deps.saveSource(source).then(() => refreshSources()).catch(() => {
        emit({ source: previous, sources: undefined, sourcesError: '答题来源保存失败，请重新检查后再选择。' });
      }).finally(() => emit({ sourceSaving: false }));
    },
    refreshSources() { if (!run && !disposed && !state.sourceSaving) void refreshSources(); },
    settingsChanged() {
      ++historyRevision;
      emit({ history: undefined });
      invalidateResults(); lastRange = undefined;
      if (run) stop();
      else { ++previewRevision; previewRequested = false; emit({ previewing: false }); }
      if (!disposed && !state.sourceSaving) void refreshSources();
    },
    async runChapter(target, signal, policy) {
      if (run) return { status: 'attention', message: '答题面板已有任务，请结束后继续章节学习。' };
      const current: Run = { abort: new AbortController(), chapter: target, policy };
      const abort = () => { current.abort.abort(); deps.runtime.cancel(); };
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
      try { return await execute(current) ?? { status: 'attention', message: '章节测验没有返回完成状态。' }; }
      catch (error) { return { status: 'attention', message: error instanceof Error ? error.message : '章节测验处理失败。' }; }
      finally { signal.removeEventListener('abort', abort); }
    },
    dispose() { unsubscribeInvalidation?.(); stop(); disposed = true; listeners.clear(); },
  };
}
