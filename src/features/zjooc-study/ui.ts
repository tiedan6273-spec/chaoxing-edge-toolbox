import type { WorkspaceContext, WorkspaceView } from '../workspace-registry';
import type { Settings } from '../toolbox-settings/types';
import type { ZjoocStudyPhase } from './types';
import { isZjoocPlaybackRate, type ZjoocPlaybackRate } from './playback-rate';
import { isZjoocStartMode, type ZjoocStartMode } from './start-position';
import { createDiagnosticView, locateLearningContent } from '../activity/diagnostics';

const phaseLabels: Record<ZjoocStudyPhase, string> = {
  disabled: '未启用', unsupported: '等待课程', waiting: '等待页面', running: '学习中',
  confirming: '等待确认', paused: '已暂停', complete: '处理结束',
};

/** The controller owns playback, navigation and completion; this view only exposes public state. */
export function createZjoocStudyView(context: WorkspaceContext): WorkspaceView {
  const controller = context.zjoocStudy;
  if (!controller) throw new Error('Missing Zjooc study controller');
  const listeners = new AbortController();
  const root = document.createElement('section');
  root.className = 'feature-view zjooc-study-view';
  root.setAttribute('aria-label', '浙学章节学习');
  root.innerHTML = `
    <div class="zjooc-heading"><h3 class="section-title">章节学习</h3><span class="phase-badge" data-zjooc-phase></span></div>
    <label class="setting-row zjooc-enable"><span><span class="setting-title">启用自动学习</span><span class="description">自动静音播放，按所选倍速学习。</span></span><input type="checkbox" role="switch" class="switch" aria-label="启用浙学自动学习" disabled></label>
    <div class="zjooc-playback"><label for="cx-zjooc-rate"><span>播放倍速</span><select id="cx-zjooc-rate" aria-describedby="cx-zjooc-rate-help" disabled><option value="highest">平台最高（默认）</option></select></label><p id="cx-zjooc-rate-help" role="status" aria-live="polite"></p></div>
    <div class="zjooc-playback zjooc-start-position"><label for="cx-zjooc-start-mode"><span>学习起点</span><select id="cx-zjooc-start-mode" aria-describedby="cx-zjooc-start-help" disabled><option value="first-unfinished">首个未完成内容</option><option value="current-forward">从当前内容往后</option></select></label><p id="cx-zjooc-start-help" role="status" aria-live="polite"></p><button class="button" type="button" data-zjooc-action="current" hidden>从当前内容开始</button></div>
    <div class="zjooc-progress">
      <p class="zjooc-project"></p><p class="zjooc-chapter"></p><p class="zjooc-resource"></p>
      <p class="zjooc-rate"></p><p class="zjooc-message" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="zjooc-progress-footer"><p class="zjooc-count"><span data-zjooc-count="confirmed"></span> · <span data-zjooc-count="pending"></span> · <span data-zjooc-count="manual"></span></p><button class="button primary" type="button" data-zjooc-action="start">开始学习</button><button class="button primary" type="button" data-zjooc-action="stop" hidden>暂停</button></div>
    </div>
    <details class="zjooc-pending" hidden><summary></summary><ul></ul></details>
    <details class="zjooc-skipped" hidden><summary></summary><ul></ul></details>
  `;
  const find = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const enable = find<HTMLInputElement>('.zjooc-enable input');
  const phase = find<HTMLElement>('[data-zjooc-phase]');
  const project = find<HTMLElement>('.zjooc-project');
  const chapter = find<HTMLElement>('.zjooc-chapter');
  const resource = find<HTMLElement>('.zjooc-resource');
  const rate = find<HTMLElement>('.zjooc-rate');
  const rateChoice = find<HTMLSelectElement>('#cx-zjooc-rate');
  const rateHelp = find<HTMLElement>('#cx-zjooc-rate-help');
  const startMode = find<HTMLSelectElement>('#cx-zjooc-start-mode');
  const startHelp = find<HTMLElement>('#cx-zjooc-start-help');
  const currentStart = find<HTMLButtonElement>('[data-zjooc-action="current"]');
  const message = find<HTMLElement>('.zjooc-message');
  const diagnostic = createDiagnosticView({ locate: locateLearningContent });
  message.after(diagnostic.element);
  const confirmedCount = find<HTMLElement>('[data-zjooc-count="confirmed"]');
  const pendingCount = find<HTMLElement>('[data-zjooc-count="pending"]');
  const manualCount = find<HTMLElement>('[data-zjooc-count="manual"]');
  const start = find<HTMLButtonElement>('[data-zjooc-action="start"]');
  const stop = find<HTMLButtonElement>('[data-zjooc-action="stop"]');
  const pending = find<HTMLDetailsElement>('.zjooc-pending');
  const pendingSummary = find<HTMLElement>('.zjooc-pending summary');
  const pendingList = find<HTMLElement>('.zjooc-pending ul');
  const skipped = find<HTMLDetailsElement>('.zjooc-skipped');
  const skippedSummary = find<HTMLElement>('.zjooc-skipped summary');
  const skippedList = find<HTMLElement>('.zjooc-skipped ul');
  let settings = context.getSettings();
  let state = controller.getState();
  let saving = false;
  let localSaving = false;
  let localError = '';
  let disposed = false;
  let pendingEnableStart = false;
  let enableRequest = 0;
  let renderedPending = '';
  let renderedSkipped = '';
  let renderedRates = '';
  let pendingRate: ZjoocPlaybackRate | undefined;
  let rateFeedback = '';
  let pendingStartMode: ZjoocStartMode | undefined;

  function startAfterEnable(): void {
    if (!pendingEnableStart || disposed || saving || localSaving) return;
    const current = context.getSettings();
    if (current && !current.enabled) pendingEnableStart = false;
    if (!current?.enabled || !current.features['zjooc-study']) return;
    pendingEnableStart = false;
    controller!.start();
  }

  function renderReasons(list: HTMLElement, reasons: string[]): void {
    list.replaceChildren(...reasons.map(reason => {
      const item = document.createElement('li');
      item.textContent = reason;
      return item;
    }));
  }

  function render(): void {
    if (disposed) return;
    const enabled = Boolean(settings?.enabled && settings.features['zjooc-study']);
    const selectedRate = pendingRate ?? settings?.zjoocPlaybackRate ?? 'highest';
    const rates = state.availablePlaybackRates;
    const unsupportedRate = selectedRate !== 'highest' && !rates.includes(selectedRate);
    const optionsKey = `${rates.join(',')}:${unsupportedRate ? selectedRate : ''}`;
    if (optionsKey !== renderedRates) {
      renderedRates = optionsKey;
      const option = (value: string, text: string, disabled = false) => {
        const element = document.createElement('option');
        element.value = value; element.textContent = text; element.disabled = disabled;
        return element;
      };
      rateChoice.replaceChildren(option('highest', '平台最高（默认）'), ...rates.map(value => option(String(value), `${value} 倍`)),
        ...(unsupportedRate ? [option(String(selectedRate), `${selectedRate} 倍（已保存，当前未提供）`, true)] : []));
    }
    rateChoice.value = String(selectedRate);
    rateChoice.disabled = !settings?.enabled || saving || localSaving || rates.length === 0;
    rateHelp.textContent = pendingRate !== undefined ? '正在保存倍速…'
      : !rates.length ? '进入视频并播放后，可读取平台倍速选项。'
        : unsupportedRate ? `当前视频未提供已保存的 ${selectedRate} 倍速，请重新选择。`
          : rateFeedback || '仅选择播放器提供的倍速，后续视频沿用。';
    rateChoice.title = !rates.length ? rateHelp.textContent : '选择后自动保存；修改不会启动或恢复暂停的学习任务。';
    const selectedMode = pendingStartMode ?? settings?.zjoocStartMode ?? 'first-unfinished';
    startMode.value = selectedMode;
    startMode.disabled = !settings?.enabled || saving || localSaving;
    startMode.title = '选择会自动保存，应用于新任务；继续学习沿用本次进度。';
    startHelp.textContent = pendingStartMode ? '正在保存学习起点…'
      : selectedMode === 'current-forward' ? '跳过当前内容之前的任务。手动换页后点下方按钮重设起点；“继续学习”沿用上次进度。'
        : '新任务从首个未完成内容开始；“继续学习”沿用本次起点和进度。';
    currentStart.hidden = selectedMode !== 'current-forward';
    currentStart.disabled = !enabled || saving || localSaving || state.phase === 'unsupported';
    currentStart.title = state.phase === 'unsupported' ? '请先进入课程学习页。' : !enabled ? '请先启用自动学习。' : '将当前打开的视频或课件设为新起点，并从这里向后学习。';
    phase.textContent = phaseLabels[state.phase];
    phase.dataset.phase = state.phase;
    enable.checked = Boolean(settings?.features['zjooc-study']);
    enable.disabled = !settings?.enabled || saving || localSaving;
    project.textContent = state.projectTitle;
    project.hidden = state.phase === 'unsupported' || !state.projectTitle;
    chapter.textContent = state.phase === 'unsupported' ? '请先进入课程学习页' : state.chapterTitle || '等待识别当前小节';
    resource.textContent = state.resourceTitle ? `当前任务 · ${state.resourceTitle}` : '';
    resource.hidden = state.phase === 'unsupported' || !state.resourceTitle;
    rate.textContent = state.playbackRate === undefined ? '' : `实际倍速 · ${state.playbackRate} 倍`;
    rate.hidden = state.playbackRate === undefined;
    message.textContent = localError || (!settings ? '正在读取工具箱设置…'
      : !settings.enabled ? '工具箱已暂停，请先启用工具箱。'
        : state.phase === 'unsupported' ? state.message
          : !enabled ? selectedMode === 'current-forward' ? '启用新任务后，从当前内容学习至课程最后一节。' : '启用后，从首个未完成内容学习至课程最后一节。' : state.message);
    message.dataset.kind = localError ? 'error' : 'info';
    diagnostic.update(enabled ? state.message : '', false, state.running);
    confirmedCount.textContent = `已确认 ${state.completed} 项`;
    pendingCount.textContent = `待平台确认 ${state.pendingConfirmation.length} 项`;
    manualCount.textContent = `需手动 ${state.skipped.length} 项`;
    start.hidden = state.running;
    start.disabled = !enabled || saving || localSaving || state.phase === 'unsupported';
    start.title = state.phase === 'unsupported' ? '请先在“我的课程”点击“进入学习”。' : !enabled ? '请先打开上方“启用自动学习”。' : '';
    start.textContent = state.phase === 'paused' ? '继续学习' : state.phase === 'complete' ? '重新检查' : '开始学习';
    stop.hidden = !state.running;
    pending.hidden = state.pendingConfirmation.length === 0;
    pendingSummary.textContent = `待平台确认 ${state.pendingConfirmation.length} 项`;
    const pendingSignature = JSON.stringify(state.pendingConfirmation);
    if (pendingSignature !== renderedPending) {
      renderedPending = pendingSignature;
      renderReasons(pendingList, state.pendingConfirmation);
    }
    skipped.hidden = state.skipped.length === 0;
    skippedSummary.textContent = `需手动 ${state.skipped.length} 项 · 处理后继续`;
    const signature = JSON.stringify(state.skipped);
    if (signature !== renderedSkipped) {
      renderedSkipped = signature;
      renderReasons(skippedList, state.skipped);
    }
  }

  enable.addEventListener('change', () => {
    if (saving || localSaving || !settings?.enabled) { render(); return; }
    const enabled = enable.checked;
    const request = ++enableRequest;
    pendingEnableStart = false;
    localSaving = true;
    localError = '';
    render();
    void context.saveSettings(current => ({ ...current, features: { ...current.features, 'zjooc-study': enabled } }))
      .then(() => {
        if (disposed || request !== enableRequest) return;
        settings = context.getSettings();
        pendingEnableStart = enabled;
      })
      .catch(() => { localError = '自动学习开关保存失败，请重试。'; })
      .finally(() => { localSaving = false; startAfterEnable(); render(); });
  }, { signal: listeners.signal });
  rateChoice.addEventListener('change', () => {
    const choice = rateChoice.value === 'highest' ? 'highest' : Number(rateChoice.value);
    if (rateChoice.disabled || !isZjoocPlaybackRate(choice) || (choice !== 'highest' && !state.availablePlaybackRates.includes(choice))) { render(); return; }
    pendingRate = choice;
    localSaving = true;
    localError = '';
    render();
    void context.saveSettings(current => ({ ...current, zjoocPlaybackRate: choice }))
      .then(() => { if (!disposed) { settings = context.getSettings(); rateFeedback = '倍速已保存，后续视频沿用。'; } })
      .catch(() => { if (!disposed) localError = '倍速保存失败，请重试。'; })
      .finally(() => { pendingRate = undefined; localSaving = false; render(); });
  }, { signal: listeners.signal });
  startMode.addEventListener('change', () => {
    const choice = startMode.value;
    if (startMode.disabled || !isZjoocStartMode(choice)) { render(); return; }
    pendingStartMode = choice;
    localSaving = true;
    localError = '';
    render();
    void context.saveSettings(current => ({ ...current, zjoocStartMode: choice }))
      .then(() => { if (!disposed) settings = context.getSettings(); })
      .catch(() => { if (!disposed) localError = '学习起点保存失败，请重试。'; })
      .finally(() => { pendingStartMode = undefined; localSaving = false; render(); });
  }, { signal: listeners.signal });
  currentStart.addEventListener('click', () => {
    if (currentStart.disabled || disposed) return;
    enableRequest++;
    pendingEnableStart = false;
    localError = '';
    controller.startFromCurrent();
  }, { signal: listeners.signal });
  start.addEventListener('click', () => {
    if (start.disabled || disposed) return;
    enableRequest++;
    pendingEnableStart = false;
    localError = '';
    controller.start(state.phase === 'complete');
  }, { signal: listeners.signal });
  stop.addEventListener('click', () => { enableRequest++; pendingEnableStart = false; localError = ''; controller.stop(); }, { signal: listeners.signal });
  const unsubscribe = controller.subscribe(value => { state = value; render(); });
  render();
  return {
    element: root,
    actions: find<HTMLElement>('.zjooc-progress-footer'),
    update(value: Settings | undefined, savingSettings: boolean) {
      settings = value;
      saving = savingSettings;
      if (value && !value.enabled) { enableRequest++; pendingEnableStart = false; }
      startAfterEnable();
      render();
    },
    refresh() { state = controller.getState(); startAfterEnable(); render(); },
    dispose() { disposed = true; enableRequest++; pendingEnableStart = false; unsubscribe(); listeners.abort(); root.remove(); },
  };
}
