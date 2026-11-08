import type { AnswerSourceMode, AnswerSourcesStatus, QuestionAnswerState } from './types';

export interface AnswerSourcePlan {
  first?: 'bank' | 'ai' | 'local';
  fallback: boolean;
  message: string;
}

function aiUnavailable(status: AnswerSourcesStatus['ai']): string {
  if (!status.enabled) return 'AI 作答已关闭，请在功能设置中开启。';
  if (!status.configured) return '尚未配置 AI，请在 AI 设置中保存接口地址、Key 和模型。';
  return 'AI 域名尚未授权，请在 AI 设置中重新保存并授权。';
}

/** The same local readiness rules drive the UI, queue preflight and background provider choice. */
export function planAnswerSource(source: AnswerSourceMode | null, status: AnswerSourcesStatus, incompleteText = false, aiOnly = false): AnswerSourcePlan {
  if (status.local?.enabled && status.local.selectedCount === 0) return { fallback: false, message: '本地辅助已开启，请至少选择一个有题目的已启用题库。' };
  if (status.local?.enabled && status.local.selectedCount > 0) return { first: 'local', fallback: status.local.onlineFallback && source !== 'local',
    message: `先查已选的 ${status.local.selectedCount} 个本地题库；${status.local.onlineFallback && source !== 'local' ? '未匹配时按所选在线来源补充。' : '未匹配时保留待处理，不请求在线服务。'}` };
  if (source === 'local') return { fallback: false, message: '请启用本地题库辅助，并至少选择一个有题目的已启用题库。' };
  if (!source) return { fallback: false, message: '请先选择答题来源，选择后才会请求答案。'
    + (!status.bank.configured && !status.ai.configured ? '尚未配置 AI 或言溪题库，至少配置一种即可。' : '') };
  const aiReady = status.ai.enabled && status.ai.configured && status.ai.authorized;
  if (aiOnly) {
    if (source === 'bank') return { fallback: false, message: '程序题需要 AI 生成代码，请切换为“仅 AI”或“言溪优先，AI 补充”。' };
    return aiReady ? { first: 'ai', fallback: false, message: '程序题将由 AI 生成代码。' }
      : { fallback: false, message: `程序题需要 AI 生成代码。${aiUnavailable(status.ai)}` };
  }
  if (incompleteText) {
    if (source === 'bank') return { fallback: false, message: '本题含未识别文字，请切换为 AI 或“言溪优先，AI 补充”。' };
    return aiReady ? { first: 'ai', fallback: false, message: '本题含未识别文字，将跳过题库并使用 AI。' }
      : { fallback: false, message: `本题含未识别文字，无法使用题库。${aiUnavailable(status.ai)}` };
  }
  if (source === 'ai') return aiReady
    ? { first: 'ai', fallback: false, message: '将直接使用 AI 答题，无需配置言溪题库。' }
    : { fallback: false, message: `当前选择“仅 AI”。${aiUnavailable(status.ai)}` };
  if (status.bank.configured) {
    // A configured provider that lost permission is an error, not a reason to silently switch services.
    if (!status.bank.authorized) return { fallback: false, message: '言溪题库域名尚未授权，请在言溪设置中重新保存并授权。' };
    if (source === 'bank') return { first: 'bank', fallback: false, message: '将仅使用言溪题库答题。' };
    return { first: 'bank', fallback: aiReady, message: aiReady
      ? '将优先查询言溪题库，未命中时使用 AI。'
      : `将使用言溪题库，未命中的题目保留待处理。${aiUnavailable(status.ai)}` };
  }
  if (source === 'bank') return { fallback: false, message: '当前选择“仅言溪”，请先在言溪设置中粘贴题库配置并保存；也可切换为“仅 AI”。' };
  if (aiReady) return { first: 'ai', fallback: false, message: '未配置言溪题库，将直接使用 AI 答题。' };
  if (!status.ai.configured) return { fallback: false, message: '尚未配置答题来源，请在“AI 设置”或“言溪设置”中至少配置一种；只配置 AI 也能自动答题。'
    + (status.ai.enabled ? '' : '使用 AI 前还需在功能设置中开启 AI 作答。') };
  return { fallback: false, message: aiUnavailable(status.ai) };
}

export function answerSourceNotice(state: QuestionAnswerState): AnswerSourcePlan {
  if (state.sourceSaving) return { fallback: false, message: '正在保存答题来源…' };
  if (state.sources) {
    const programOnly = state.rows.length > 0 && state.rows.every(row => row.target.question.kind === 'program');
    const regular = planAnswerSource(state.source, state.sources, false, programOnly);
    return regular.first || !state.rows.some(row => row.target.question.supported && row.target.question.textRecognition)
      ? regular : planAnswerSource(state.source, state.sources, true, programOnly);
  }
  return { fallback: false, message: state.sourcesError || '正在检查答题来源配置…' };
}
