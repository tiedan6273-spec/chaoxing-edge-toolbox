import type { WorkspaceContext, WorkspaceView } from '../workspace-registry';
import { isFeatureEnabled, type Settings } from '../toolbox-settings/types';
import { answerSourceNotice } from '../question-answer/source-status';
import type { SettingsSection } from '../../platform/settings-navigation';
import { STUDY_RATES, type StudyPhase, type StudyPreferences, type StudyTaskType } from './types';
import { readNotificationSettings, subscribeNotificationSettings, writeNotificationSettings } from './notification-client';
import type { StudyNotificationSettings } from './notifications';
import { createQuestionAnswerView } from '../question-answer/ui';
import { createSceneToolsView } from '../page-tools/ui';
import { createDiagnosticView, locateLearningContent } from '../activity/diagnostics';

const phaseLabels: Record<StudyPhase, string> = {
  disabled: '未启用', unsupported: '暂不支持', waiting: '等待页面', running: '学习中',
  confirming: '确认完成', paused: '已暂停', complete: '学习结束', error: '需要处理',
  verification: '等待验证', recovering: '正在恢复', 'manual-play': '等待手动播放',
};

const taskLabels: Record<StudyTaskType, string> = {
  video: '视频 / 音频', courseware: 'PPT / 文档', 'audio-ppt': '带音频 PPT',
  book: '书籍阅读', hyperlink: '链接阅读', 'chapter-test': '章节测验',
};

/** The view renders public controller state; all playback and navigation belong to the feature controller. */
export function createChapterStudyView(context: WorkspaceContext): WorkspaceView {
  const controller = context.study;
  if (!controller) throw new Error('当前网站不支持学习通章节学习。');
  const study = controller;
  let settings = context.getSettings();
  let state = study.getState();
  function manualAnswerOnly(): boolean {
    return !settings?.features['chapter-study'] || !(state.preferences.chapterAnswer ?? true);
  }
  const listeners = new AbortController();
  const { signal } = listeners;
  const root = document.createElement('section');
  root.className = 'feature-view chapter-study-view';
  root.setAttribute('aria-label', '章节学习');
  root.innerHTML = `
    <div class="study-heading"><h3 class="section-title">章节学习</h3><span class="phase-badge study-phase"></span><label class="switch-label study-enable"><span>启用</span><input type="checkbox" role="switch" class="switch" aria-label="启用章节学习" aria-describedby="cx-study-enable-help" disabled></label></div>
    <details class="study-playback" open><summary>播放设置</summary><fieldset class="study-preferences" aria-label="播放设置">
      <div class="study-media-settings"><label class="study-field" for="cx-study-rate"><span>播放倍速</span><select id="cx-study-rate"></select></label><label class="switch-label study-muted"><span>静音播放</span><input type="checkbox" role="switch" class="switch" data-study-muted aria-label="静音播放"></label><label class="switch-label study-muted"><span>自动续播</span><input type="checkbox" role="switch" class="switch" data-study-auto-resume aria-label="自动续播"></label></div>
      <p class="study-rate-warning" id="cx-study-rate-warning" role="status" aria-live="polite" aria-atomic="true" hidden></p>
      <p class="study-preference-feedback" role="status" aria-live="polite" hidden></p>
    </fieldset></details>
    <div class="study-answer-source" hidden><label class="study-field" for="cx-study-answer-source"><span>测验答题来源</span><select id="cx-study-answer-source"><option value="" disabled>请选择答题来源</option><option value="local">仅本地题库</option><option value="prefer-bank">言溪优先，AI 补充</option><option value="bank">仅言溪</option><option value="ai">仅 AI</option></select></label><p class="answer-config-status" role="status" aria-live="polite"></p><div class="study-actions"><button class="button" type="button" data-study-answer-settings="api">AI 设置</button><button class="button" type="button" data-study-answer-settings="question-bank">言溪设置</button><button class="button" type="button" data-study-answer-settings="features">功能设置</button><button class="button" type="button" data-study-answer-recheck hidden>重新检查</button></div></div>
    <div class="study-progress">
      <p class="study-chapter"></p><p class="study-task"></p>
      <p class="study-message" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="study-progress-footer"><p class="study-count"></p><div class="study-actions"><button class="button primary" type="button" data-study-action="start">开始学习</button><button class="button primary" type="button" data-study-action="stop" hidden>暂停</button></div></div>
    </div>
    <div class="study-quiz-controls">
      <label class="study-field" for="cx-study-chapter-answer-finish"><span>测验完成后</span><select id="cx-study-chapter-answer-finish" aria-describedby="cx-study-chapter-answer-help"><option value="save">暂时保存并继续（默认）</option><option value="submit">全部填好后提交并继续</option><option value="stay">停留检查</option></select></label>
    </div>
    <div class="study-question-paper" hidden></div>
    <details class="study-more"><summary>更多设置</summary><div class="study-more-content">
      <label class="switch-label"><span>章节测验自动答题</span><input type="checkbox" role="switch" class="switch" data-study-chapter-answer aria-label="章节测验自动答题" aria-describedby="cx-study-chapter-answer-help"></label>
      <p class="study-field-help" id="cx-study-chapter-answer-help">启动章节学习后按所选来源答题；保存成功后继续。暂时保存不代表已提交。</p>
      <div class="study-preference-grid">
        <label class="study-field" for="cx-study-start-mode"><span>学习起点</span><select id="cx-study-start-mode"><option value="first-unfinished">首个未完成任务点</option><option value="current-forward">从当前章节向后</option></select></label>
        <label class="study-field" for="cx-study-video-quiz"><span>视频内题目</span><select id="cx-study-video-quiz" aria-describedby="cx-study-quiz-help"><option value="random">随机作答</option><option value="ignore">忽略</option></select></label>
      </div>
      <p class="study-field-help" id="cx-study-quiz-help">视频内题目设置从下一个视频生效。</p>
      <div class="study-notifications"><label class="switch-label"><span>需要处理时通知我</span><input type="checkbox" role="switch" class="switch" data-study-notifications aria-label="需要处理时通知我" aria-describedby="cx-study-notification-help" disabled></label><button class="button" type="button" data-study-notification-settings>通知设置</button></div>
      <p class="study-field-help" id="cx-study-notification-help" role="status" aria-live="polite">系统通知默认关闭，工具箱内的提示始终显示。</p>
      <p class="study-field-help" id="cx-study-enable-help">启用后进入章节详情自动学习，可随时暂停。</p>
      <p class="study-field-help study-boundary">章节测验按上述设置处理，草稿保存不代表任务点完成；完成情况以平台状态为准。播放受阻时按页面提示处理。</p>
    </div></details>
    <details class="study-skipped" hidden><summary></summary><ul></ul></details>
  `;
  function element<T extends HTMLElement>(selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing study UI element: ${selector}`);
    return found;
  }
  const phase = element<HTMLElement>('.study-phase');
  const playback = element<HTMLDetailsElement>('.study-playback');
  const moreContent = element<HTMLElement>('.study-more-content');
  const studyProgress = element<HTMLElement>('.study-progress');
  const paper = element<HTMLElement>('.study-question-paper');
  const answerView = context.questionAnswer ? createQuestionAnswerView({ answer: context.questionAnswer, openSettings: context.openSettings,
    title: '章节测验 · 题目与答案', embedded: true, showRunActions: manualAnswerOnly, canRun: () => !state.running }) : undefined;
  if (answerView) paper.append(answerView.element);
  const tools = createSceneToolsView(context, { includeExtraction: !answerView });
  moreContent.append(tools.element);
  const enable = element<HTMLInputElement>('.study-enable input');
  const mode = element<HTMLSelectElement>('#cx-study-start-mode');
  const videoQuiz = element<HTMLSelectElement>('#cx-study-video-quiz');
  const rate = element<HTMLSelectElement>('#cx-study-rate');
  const rateWarning = element<HTMLElement>('#cx-study-rate-warning');
  const muted = element<HTMLInputElement>('[data-study-muted]');
  const autoResume = element<HTMLInputElement>('[data-study-auto-resume]');
  const chapterAnswer = element<HTMLInputElement>('[data-study-chapter-answer]');
  const chapterAnswerFinish = element<HTMLSelectElement>('#cx-study-chapter-answer-finish');
  const answerSources = element<HTMLElement>('.study-answer-source');
  const answerSource = element<HTMLSelectElement>('#cx-study-answer-source');
  const answerSourcesMessage = element<HTMLElement>('.study-answer-source p');
  const answerSourcesActions = element<HTMLElement>('.study-answer-source .study-actions');
  const answerRecheck = element<HTMLButtonElement>('[data-study-answer-recheck]');
  const notificationToggle = element<HTMLInputElement>('[data-study-notifications]');
  const notificationHelp = element<HTMLElement>('#cx-study-notification-help');
  const feedback = element<HTMLElement>('.study-preference-feedback');
  const message = element<HTMLElement>('.study-message');
  const diagnostic = createDiagnosticView({ locate: locateLearningContent });
  message.after(diagnostic.element);
  const chapter = element<HTMLElement>('.study-chapter');
  const task = element<HTMLElement>('.study-task');
  const count = element<HTMLElement>('.study-count');
  const start = element<HTMLButtonElement>('[data-study-action="start"]');
  const stop = element<HTMLButtonElement>('[data-study-action="stop"]');
  const skipped = element<HTMLDetailsElement>('.study-skipped');
  const skippedSummary = element<HTMLElement>('.study-skipped summary');
  const skippedList = element<HTMLUListElement>('.study-skipped ul');
  moreContent.append(skipped);
  for (const value of STUDY_RATES) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} 倍`;
    rate.append(option);
  }
  let saving = false;
  let preferencesSaving = false;
  let pendingPreferences: StudyPreferences | undefined;
  let answerState = context.questionAnswer?.getState();
  let localError = '';
  let preferenceFeedback = '';
  let disposed = false;
  let renderedSkipped = '';
  let notifications: StudyNotificationSettings | undefined;
  let notificationSaving = false;
  let notificationRevision = 0;
  let lastQuiz = false;

  function render(): void {
    if (disposed) return;
    const enabled = Boolean(settings?.enabled && settings.features['chapter-study']);
    diagnostic.update(enabled ? state.message : '', state.phase === 'error', state.running);
    const quiz = state.taskType === 'chapter-test' || (!state.taskType && Boolean(answerState?.papers?.some(value => value.scene === 'chapter-test')));
    if (quiz !== lastQuiz) {
      playback.open = !quiz;
      if (quiz) moreContent.prepend(playback);
      else root.insertBefore(playback, studyProgress);
      lastQuiz = quiz;
    }
    paper.hidden = !quiz || !answerView;
    root.dataset.task = quiz ? 'chapter-test' : state.taskType || 'waiting';
    answerView?.update(settings, saving);
    tools.update(settings, saving);
    phase.textContent = phaseLabels[state.phase];
    phase.dataset.phase = state.phase;
    enable.checked = Boolean(settings?.features['chapter-study']);
    enable.disabled = !settings?.enabled || saving;
    const preferencesDisabled = !enabled || saving || preferencesSaving;
    const selectedPreferences = pendingPreferences || state.preferences;
    mode.value = state.preferences.startMode;
    mode.disabled = preferencesDisabled || state.running;
    mode.title = state.running ? '暂停后可更改学习起点。' : '';
    videoQuiz.value = state.preferences.videoQuiz;
    videoQuiz.disabled = preferencesDisabled;
    rate.value = String(selectedPreferences.playbackRate);
    rate.disabled = preferencesDisabled;
    rateWarning.hidden = selectedPreferences.playbackRate <= 2;
    rateWarning.textContent = rateWarning.hidden ? '' : '超过 2 倍速有播放失败风险；失败后降至 2 倍，再失败降至 1 倍。'
      + (selectedPreferences.autoResume ? '已开启自动续播。' : '自动续播已关闭，需手动播放。');
    if (rateWarning.hidden) rate.removeAttribute('aria-describedby');
    else rate.setAttribute('aria-describedby', rateWarning.id);
    muted.checked = state.preferences.muted;
    muted.disabled = preferencesDisabled;
    autoResume.checked = selectedPreferences.autoResume;
    autoResume.disabled = preferencesDisabled;
    chapterAnswer.checked = selectedPreferences.chapterAnswer ?? true;
    chapterAnswer.disabled = preferencesDisabled || state.running;
    chapterAnswer.title = state.running ? '暂停后可更改章节测验联动。' : '';
    chapterAnswerFinish.value = selectedPreferences.chapterAnswerFinish ?? 'save';
    chapterAnswerFinish.disabled = preferencesDisabled || state.running || !chapterAnswer.checked;
    chapterAnswerFinish.title = state.running ? '暂停后可更改章节测验完成方式。' : '';
    answerSources.hidden = quiz || !enabled || !chapterAnswer.checked || !answerState;
    if (answerState && settings) {
      answerSource.value = answerState.source ?? '';
      answerSource.disabled = !enabled || saving || answerState.running || Boolean(answerState.sourceSaving);
      const notice = answerSourceNotice(answerState);
      const answerEnabled = isFeatureEnabled(settings, 'question-answer');
      const ready = answerEnabled && Boolean(notice.first);
      if (ready && answerSources.parentElement !== moreContent) moreContent.append(answerSources);
      else if (!ready && answerSources.parentElement !== root) root.insertBefore(answerSources, studyProgress);
      answerSourcesMessage.textContent = `章节测验：${answerEnabled ? notice.message : '批量答题功能已关闭，请在功能设置中开启。'}`
        + (ready ? '' : '视频等任务可继续；遇到未完成测验时将暂停。');
      answerSourcesMessage.dataset.kind = ready ? 'info' : 'warning';
      answerSourcesActions.hidden = ready;
      answerRecheck.hidden = !answerState.sourcesError;
      answerRecheck.disabled = answerState.running;
    }
    notificationToggle.checked = notifications?.enabled ?? false;
    notificationToggle.disabled = !notifications || notificationSaving;
    feedback.textContent = preferencesSaving ? '正在保存学习设置…' : preferenceFeedback;
    feedback.hidden = !feedback.textContent;
    message.textContent = localError || (!settings ? '正在读取工具箱设置…'
      : !settings.enabled ? '工具箱已暂停。请先打开上方“启用工具箱”。'
        : !enabled ? '章节学习已关闭。启用后会按已保存的设置自动学习。' : state.message);
    message.dataset.kind = localError || state.phase === 'error' ? 'error'
      : state.phase === 'verification' || state.phase === 'manual-play' ? 'warning' : 'info';
    message.hidden = quiz && !localError && enabled && state.phase === 'running' && Boolean(answerState?.running);
    chapter.textContent = state.chapterTitle ? `当前章节 · ${state.chapterTitle}` : '等待识别当前章节';
    chapter.hidden = quiz;
    task.textContent = state.taskType ? `当前任务 · ${taskLabels[state.taskType]}` : '';
    task.hidden = !task.textContent || quiz;
    count.textContent = `已完成 ${state.completed} 项 · 已跳过 ${state.skipped.length} 项`;
    count.hidden = quiz;
    start.hidden = state.running || Boolean(answerState?.running) || (quiz && manualAnswerOnly());
    start.disabled = !enabled || saving || preferencesSaving || state.phase === 'unsupported';
    start.textContent = state.phase === 'paused' ? '继续学习' : state.phase === 'complete' ? '重新开始' : '开始学习';
    stop.hidden = !state.running && !answerState?.running;
    stop.disabled = false;
    skipped.hidden = state.skipped.length === 0;
    skippedSummary.textContent = `已跳过 ${state.skipped.length} 项 · 查看原因`;
    const skippedSignature = JSON.stringify(state.skipped);
    if (skippedSignature !== renderedSkipped) {
      renderedSkipped = skippedSignature;
      skippedList.replaceChildren(...state.skipped.map((reason) => {
        const item = document.createElement('li');
        item.textContent = reason;
        return item;
      }));
    }
  }

  async function savePreferences(update: Partial<StudyPreferences>): Promise<void> {
    if (preferencesSaving || disposed) return;
    const next = { ...state.preferences, ...update };
    preferencesSaving = true;
    pendingPreferences = next;
    preferenceFeedback = '';
    localError = '';
    render();
    try {
      await study.updatePreferences(next);
      preferenceFeedback = '学习设置已保存。';
    } catch {
      localError = '学习设置保存失败，已恢复原设置，请重试。';
    } finally {
      preferencesSaving = false;
      pendingPreferences = undefined;
      render();
    }
  }

  enable.addEventListener('change', () => {
    const enabled = enable.checked;
    localError = '';
    void context.saveSettings((current) => ({ ...current, features: { ...current.features, 'chapter-study': enabled } }))
      .catch(() => { localError = '章节学习开关保存失败，请重试。'; render(); });
  }, { signal });
  mode.addEventListener('change', () => { void savePreferences({ startMode: mode.value === 'current-forward' ? 'current-forward' : 'first-unfinished' }); }, { signal });
  videoQuiz.addEventListener('change', () => { void savePreferences({ videoQuiz: videoQuiz.value === 'ignore' ? 'ignore' : 'random' }); }, { signal });
  rate.addEventListener('change', () => { void savePreferences({ playbackRate: Number(rate.value) }); }, { signal });
  muted.addEventListener('change', () => { void savePreferences({ muted: muted.checked }); }, { signal });
  autoResume.addEventListener('change', () => { void savePreferences({ autoResume: autoResume.checked }); }, { signal });
  chapterAnswer.addEventListener('change', () => { void savePreferences({ chapterAnswer: chapterAnswer.checked }); }, { signal });
  chapterAnswerFinish.addEventListener('change', () => {
    const value = chapterAnswerFinish.value;
    void savePreferences({ chapterAnswerFinish: value === 'submit' || value === 'stay' ? value : 'save' });
  }, { signal });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-study-answer-settings]')) {
    button.addEventListener('click', () => {
      void context.openSettings(button.dataset.studyAnswerSettings as SettingsSection).catch(() => {
        if (!disposed) { localError = '无法打开设置，请从扩展菜单进入设置页。'; render(); }
      });
    }, { signal });
  }
  answerRecheck.addEventListener('click', () => context.questionAnswer?.refreshSources(), { signal });
  answerSource.addEventListener('change', () => {
    if (answerSource.disabled) return;
    const value = answerSource.value;
    if (value === 'ai' || value === 'bank' || value === 'prefer-bank' || value === 'local') context.questionAnswer?.setSource(value);
  }, { signal });
  const openNotificationSettings = () => {
    void context.openSettings('features').catch(() => {
      if (!disposed) notificationHelp.textContent = '无法打开设置页，请从扩展菜单进入“功能设置”。';
    });
  };
  element<HTMLButtonElement>('[data-study-notification-settings]').addEventListener('click', openNotificationSettings, { signal });
  notificationToggle.addEventListener('change', () => {
    if (!notifications || notificationSaving) return;
    const enabled = notificationToggle.checked;
    if (enabled && !notifications.granted) {
      notificationHelp.textContent = '请在扩展设置页点击“开启系统通知”完成首次授权，授权后自动启用。';
      render();
      openNotificationSettings();
      return;
    }
    notificationSaving = true;
    render();
    void writeNotificationSettings(enabled).then(value => {
      notifications = value;
      if (!disposed) notificationHelp.textContent = enabled ? '系统通知已开启，同一次验证只提醒一次。' : '系统通知已关闭，工具箱内仍显示提示。';
    }).catch(() => { if (!disposed) notificationHelp.textContent = '通知设置保存失败，请重试。'; })
      .finally(() => { notificationSaving = false; render(); });
  }, { signal });
  const unsubscribeNotifications = subscribeNotificationSettings(value => {
    notificationRevision++;
    notifications = value;
    if (!disposed) notificationHelp.textContent = value.enabled ? '系统通知已开启，同一次验证只提醒一次。' : '系统通知已关闭，工具箱内仍显示提示。';
    render();
  });
  const initialNotificationRevision = notificationRevision;
  void readNotificationSettings().then(value => {
    if (notificationRevision === initialNotificationRevision) notifications = value;
    render();
  }).catch(() => { if (!disposed) notificationHelp.textContent = '通知设置读取失败，请打开“通知设置”重试。'; });
  start.addEventListener('click', () => { localError = ''; study.start(); }, { signal });
  stop.addEventListener('click', () => { localError = ''; study.stop(); context.questionAnswer?.stop(); }, { signal });
  const unsubscribe = study.subscribe((value) => {
    const enteringQuiz = value.taskType === 'chapter-test' && (state.taskType !== 'chapter-test' || state.chapterTitle !== value.chapterTitle);
    state = value; render();
    if (enteringQuiz && root.isConnected && !root.closest('[hidden]')) answerView?.refresh?.();
  });
  const unsubscribeAnswer = context.questionAnswer?.subscribe(value => { answerState = value; render(); });
  render();
  return {
    element: root,
    actions: root.querySelector<HTMLElement>('.study-progress-footer')!,
    update(value: Settings | undefined, pending: boolean) { settings = value; saving = pending; render(); },
    refresh() { state = study.getState(); answerView?.refresh?.(); render(); },
    dispose() { disposed = true; unsubscribe(); unsubscribeAnswer?.(); unsubscribeNotifications(); answerView?.dispose(); tools.dispose(); listeners.abort(); root.remove(); },
  };
}
