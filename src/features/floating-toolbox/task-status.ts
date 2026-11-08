import type { AiAnswerController } from '../ai-answer/types';
import type { StudyController } from '../chapter-study/types';
import type { QuestionAnswerController } from '../question-answer/types';
import type { ZjoocStudyController } from '../zjooc-study/types';
import type { ToolboxView } from './preferences';

export interface TaskControllers {
  ai?: AiAnswerController; study?: StudyController;
  questionAnswer?: QuestionAnswerController; zjoocStudy?: ZjoocStudyController;
}
export interface ToolboxTask {
  label: string; detail: string; message: string;
  tone: 'idle' | 'running' | 'paused' | 'attention' | 'complete';
  action?: { label: string; icon: 'pause' | 'play'; run(): void };
}

/** Both expanded and compact UI read controllers; visibility never owns a task. */
export function describeToolboxTask(view: ToolboxView, controllers: TaskControllers): ToolboxTask {
  if ((view === 'page-tools' || view === 'zjooc-exam') && controllers.questionAnswer) {
    const controller = controllers.questionAnswer;
    const state = controller.getState();
    const flow = controller.flow?.getState();
    if (flow?.running) return { label: '跨页处理中', detail: flow.progress ? `${flow.progress.pages} 页 · ${flow.progress.processed} 题` : '正在检查分页',
      message: flow.message, tone: 'running', action: { label: '暂停', icon: 'pause', run: () => controller.stop() } };
    const done = state.rows.filter(row => state.mode === 'search' ? row.phase === 'searched' : row.phase === 'filled' || row.phase === 'existing').length;
    const running = state.running || Boolean(state.reviewing);
    const tone = running ? 'running' : state.previewStale ? 'attention' : state.phase === 'paused' ? 'paused'
      : state.phase === 'error' || state.previewStale ? 'attention' : state.phase === 'complete' ? 'complete' : 'idle';
    return {
      label: state.reviewing ? '复检中' : running ? state.mode === 'search' ? '搜题中' : '处理中' : tone === 'paused' ? '已暂停'
        : tone === 'attention' ? '需处理' : tone === 'complete' ? '本轮结束' : '题目辅助',
      detail: state.rows.length ? `${done} / ${state.rows.length} 题` : '展开识别当前页',
      message: `${state.message} 暂停只影响插件处理，平台计时不变。`, tone,
      action: running ? { label: '暂停', icon: 'pause', run: () => controller.stop() }
        : tone === 'paused' && state.rows.length && !state.previewStale ? { label: '继续', icon: 'play', run: () => controller.start() } : undefined,
    };
  }
  if (view === 'chapter-study' && controllers.study) {
    const controller = controllers.study;
    const state = controller.getState();
    const attention = ['verification', 'manual-play', 'error'].includes(state.phase);
    return {
      label: attention ? '需处理' : state.phase === 'paused' ? '已暂停' : state.phase === 'complete' ? '本轮结束' : state.running ? '学习中' : '章节学习',
      detail: state.completed ? `已处理 ${state.completed} 项` : '查看当前章节', message: state.message,
      tone: attention ? 'attention' : state.running ? 'running' : state.phase === 'paused' ? 'paused' : state.phase === 'complete' ? 'complete' : 'idle',
      action: state.running ? { label: '暂停', icon: 'pause', run: () => { controller.stop(); controllers.questionAnswer?.stop(); } }
        : state.phase === 'paused' ? { label: '继续', icon: 'play', run: () => controller.start() } : undefined,
    };
  }
  if (view === 'zjooc-study' && controllers.zjoocStudy) {
    const controller = controllers.zjoocStudy;
    const state = controller.getState();
    const pending = state.pendingConfirmation.length;
    return {
      label: state.phase === 'paused' ? '已暂停' : state.running ? '学习中' : pending ? '待确认' : state.phase === 'complete' ? '本轮结束' : '章节学习',
      detail: `已确认 ${state.completed} 项${pending ? ` · 待确认 ${pending}` : ''}`, message: state.message,
      tone: state.running ? 'running' : state.phase === 'paused' ? 'paused' : pending ? 'attention' : state.phase === 'complete' ? 'complete' : 'idle',
      action: state.running ? { label: '暂停', icon: 'pause', run: () => controller.stop() }
        : state.phase === 'paused' ? { label: '继续', icon: 'play', run: () => controller.start() } : undefined,
    };
  }
  if (view === 'answer' && controllers.ai) {
    const controller = controllers.ai;
    const state = controller.getState();
    return {
      label: state.running ? '处理中' : state.phase === 'paused' ? '已暂停' : '思维阶梯',
      detail: state.question ? '当前简答题' : '展开查看详情', message: state.message,
      tone: state.running ? 'running' : state.phase === 'paused' ? 'paused' : ['error', 'blocked', 'needs-config'].includes(state.phase) ? 'attention' : 'idle',
      action: state.running ? { label: '暂停', icon: 'pause', run: () => controller.stop() }
        : state.phase === 'paused' && state.question ? { label: '继续', icon: 'play', run: () => controller.start() } : undefined,
    };
  }
  return { label: '页面工具', detail: '展开查看可用功能', message: '展开工具箱查看当前页面支持的功能。', tone: 'idle' };
}
