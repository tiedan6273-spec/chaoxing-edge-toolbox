import { FEATURES, isFeatureSupported, type FeatureId } from '../catalog';
import { getPlatformById, type PlatformId } from '../../shared/sites';
import { readSettings, subscribeSettings, writeSettings } from '../../platform/storage';
import type { Settings } from '../../shared/settings';

/** Global feature controls. The options entrypoint owns routing, never feature policy. */
export function mountToolboxSettings(root: HTMLElement): () => void {
  root.innerHTML = `<div class="card">
    <div class="section-heading"><h2>功能设置</h2><p>按网站自动显示可用功能；更改后自动保存并应用到已打开的页面。</p></div>
    <div class="master-row"><div><label class="control-title" for="master-switch">工具箱总开关</label><p id="master-detail">正在读取设置…</p></div>
    <label class="switch"><input id="master-switch" type="checkbox" role="switch" aria-describedby="master-detail" disabled /><span class="switch-track" aria-hidden="true"></span></label></div>
    <div class="feature-list"></div></div>
    <div class="feedback" role="status" aria-live="polite" aria-atomic="true" hidden></div>
    <button class="secondary retry-button" type="button" hidden>重新读取设置</button>`;
  const master = root.querySelector<HTMLInputElement>('#master-switch')!;
  const detail = root.querySelector<HTMLElement>('#master-detail')!;
  const list = root.querySelector<HTMLElement>('.feature-list')!;
  const feedback = root.querySelector<HTMLElement>('.feedback')!;
  const retry = root.querySelector<HTMLButtonElement>('.retry-button')!;
  const switches = new Map<FeatureId, HTMLInputElement>();
  const locations: Record<string, string> = {
    'allow-paste': '在网页迷你工具栏或悬浮框中快速开关，直接粘贴到页面输入框或代码编辑器。',
    'question-extract': '在网页悬浮框中提取、编辑预览，逐题复制或复制全部题目。',
    'ai-answer': '共用 API 设置，为“答题”面板提供 AI；思维阶梯简答题仍由你手动发送。',
    'question-answer': '在“答题”面板选择言溪或 AI，开始后逐题填写；章节测验可在启动章节学习后联动。',
    'chapter-study': '启用后进入章节详情页自动学习；在“章节学习”工作区调整起点、倍速和静音，随时暂停或继续。',
    'zjooc-study': '启用后进入课程学习详情页自动静音播放视频、选择平台最高倍速，并点击课件“完成学习”，直至课程最后一节。',
  };
  let settings: Settings | undefined;
  let saving = false;
  let loading = false;
  let events = 0;
  let disposed = false;

  function tell(message: string, error = false): void {
    feedback.textContent = message;
    feedback.dataset.kind = error ? 'error' : 'success';
    feedback.hidden = false;
  }

  function render(): void {
    if (disposed) return;
    master.checked = settings?.enabled ?? false;
    master.disabled = !settings || loading || saving;
    detail.textContent = saving ? '正在保存…' : !settings ? '设置尚未就绪，请重新读取。'
      : settings.enabled ? '已开启，按下方开关启用各项功能。' : '已暂停；各功能的开关状态会保留。';
    for (const [id, input] of switches) {
      input.checked = settings?.features[id] ?? false;
      input.disabled = !settings || loading || saving;
    }
    retry.disabled = loading || saving;
  }

  async function load(): Promise<void> {
    if (loading || saving || disposed) return;
    const start = events;
    loading = true;
    render();
    try {
      const loaded = await readSettings();
      if (events === start) settings = loaded;
      retry.hidden = true;
      feedback.hidden = true;
    } catch {
      if (!settings) {
        retry.hidden = false;
        tell('设置读取失败，请重新读取。', true);
      }
    } finally {
      loading = false;
      render();
    }
  }

  async function save(update: (current: Settings) => Settings, message: string): Promise<void> {
    if (!settings || loading || saving || disposed) { render(); return; }
    const previous = settings;
    const start = events;
    settings = update(previous);
    saving = true;
    render();
    try {
      await writeSettings(settings);
      if (!disposed) tell(message);
    } catch {
      if (events === start) settings = previous;
      if (!disposed) tell('保存失败。已恢复到最近读取的设置，请重试。', true);
    } finally {
      saving = false;
      render();
    }
  }

  const groups = [
    { id: 'shared', label: '学习通与浙学共用', features: FEATURES.filter(feature => feature.supportedPlatforms.length > 1) },
    ...(['chaoxing', 'zjooc'] satisfies PlatformId[]).map(platformId => ({
      id: platformId, label: getPlatformById(platformId).label,
      features: FEATURES.filter(feature => feature.supportedPlatforms.length === 1 && isFeatureSupported(feature.id, platformId)),
    })),
  ];
  for (const descriptor of groups) {
    const group = document.createElement('section');
    group.dataset.platform = descriptor.id;
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const title = document.createElement('h3');
    title.className = 'control-title';
    title.id = `platform-${descriptor.id}`;
    title.textContent = descriptor.label;
    group.setAttribute('aria-labelledby', title.id);
    heading.append(title);
    group.append(heading);
    list.append(group);
    for (const feature of descriptor.features) {
      const row = document.createElement('div');
      row.className = 'feature-row';
      const copy = document.createElement('div');
      copy.className = 'feature-copy';
      const label = document.createElement('label');
      label.className = 'control-title';
      label.htmlFor = `feature-${feature.id}`;
      label.textContent = feature.title;
      const description = document.createElement('p');
      description.id = `description-${feature.id}`;
      description.textContent = feature.description;
      const location = document.createElement('p');
      location.className = 'feature-location';
      location.id = `location-${feature.id}`;
      location.textContent = locations[feature.id] ?? '在网页悬浮工具箱中操作。';
      if (descriptor.id === 'shared') location.textContent += '此开关同时应用于学习通与浙学。';
      copy.append(label, description, location);
      const toggle = document.createElement('label');
      toggle.className = 'switch';
      const input = document.createElement('input');
      input.id = label.htmlFor;
      input.type = 'checkbox';
      input.disabled = true;
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-describedby', `${description.id} ${location.id}`);
      const track = document.createElement('span');
      track.className = 'switch-track';
      track.setAttribute('aria-hidden', 'true');
      toggle.append(input, track);
      row.append(copy, toggle);
      group.append(row);
      switches.set(feature.id, input);
      input.addEventListener('change', () => {
        const enabled = input.checked;
        void save(current => ({ ...current, features: { ...current.features, [feature.id]: enabled } }), `${feature.title}已${enabled ? '开启' : '关闭'}。`);
      });
    }
  }
  master.addEventListener('change', () => {
    const enabled = master.checked;
    void save(current => ({ ...current, enabled }), `工具箱已${enabled ? '开启' : '暂停'}。`);
  });
  retry.addEventListener('click', () => void load());
  const unsubscribe = subscribeSettings(updated => {
    events += 1;
    settings = updated;
    retry.hidden = true;
    render();
  });
  void load();
  return () => { disposed = true; unsubscribe(); };
}
