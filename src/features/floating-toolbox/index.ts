import type { AiAnswerController } from '../ai-answer/types';
import type { ApiStatus } from '../api-settings/types';
import type { StudyController } from '../chapter-study/types';
import type { ZjoocStudyController } from '../zjooc-study/types';
import type { QuestionAnswerController } from '../question-answer/types';
import { getWorkspaces, resolveSceneWorkspace, workspaceStyles, type WorkspaceView } from '../workspace-registry';
import { getPlatform, type Platform } from '../../shared/sites';
import type { ExtractionResponse } from '../../shared/messages';
import type { Settings } from '../../shared/settings';
import type { SettingsSection } from '../../platform/settings-navigation';
import { observePageContext, readPageContext } from '../../platform/page-context';
import { icon } from './icons';
import { TOOLBOX_LAYOUT } from './layout';
import { installFloatingContainer } from './container';
import { normalizeToolboxView, type ToolboxView, type ToolboxViewRequest, type UiSnapshot, type UiUpdate, type UiWriteResult } from './preferences';
import { toolboxStyles } from './styles';
import { describeToolboxTask } from './task-status';

export interface FloatingPanelDependencies {
  getSettings(): Settings | undefined;
  saveSettings(update: (current: Settings) => Settings): Promise<void>;
  extract(): Promise<ExtractionResponse>;
  openSettings(section?: SettingsSection): Promise<void>;
  getApiStatus(): Promise<ApiStatus>;
  platform?: Platform;
  ai?: AiAnswerController;
  questionAnswer?: QuestionAnswerController;
  study?: StudyController;
  zjoocStudy?: ZjoocStudyController;
  loadUiPreferences(): Promise<UiSnapshot>;
  saveUiPreferences(value: UiUpdate): Promise<UiWriteResult>;
  version: string;
}

export interface FloatingPanelController {
  update(settings: Settings): void;
  updatePreferences(preferences: UiSnapshot): void;
  open(view?: ToolboxViewRequest): void;
  dispose(): void;
}

let activePanel: FloatingPanelController | undefined;

/** Layout/navigation only. Each feature owns its own UI and transient data. */
export function installFloatingPanel(dependencies: FloatingPanelDependencies): FloatingPanelController {
  if (activePanel) return activePanel;
  const identified = dependencies.platform ?? getPlatform(location.href);
  if (!identified) return { update() {}, updatePreferences() {}, open() {}, dispose() {} };
  const platform = identified;
  const workspaces = getWorkspaces(platform.id);
  const singleWorkspace = workspaces.length === 1;
  const listeners = new AbortController();
  const { signal } = listeners;
  const host = document.createElement('div');
  host.id = 'cx-toolbox-root';
  host.dataset.cxToolbox = 'floating';
  host.dataset.platform = platform.id;
  for (const [name, value] of Object.entries({
    all: 'initial', position: 'fixed', display: 'block', 'z-index': '2147483646',
    margin: '0', padding: '0', border: '0', transform: 'none', direction: 'ltr',
    'text-align': 'left', 'color-scheme': 'light',
    width: `min(${TOOLBOX_LAYOUT.compactWidth}px, calc(100vw - 24px))`,
    height: 'auto',
  })) host.style.setProperty(name, value, 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [toolboxStyles, workspaceStyles].join('\n');
  const root = document.createElement('div');
  root.className = 'toolbox-shell';
  root.innerHTML = `
    <section class="panel" role="region" aria-label="学习工具箱">
      <button class="floating-dot" data-action="restore" data-drag-handle type="button" aria-label="恢复工具箱，拖动可调整位置" title="点击恢复工具箱 · 拖动调整位置"><span aria-hidden="true">${icon('study', 14)}<i class="dot-state"></i></span></button>
      <header class="header" data-drag-handle tabindex="0" aria-label="拖动工具箱，方向键移动，Home 复位位置" title="拖动标题栏 · 方向键移动 · Home 复位">
        <span class="drag-grip" aria-hidden="true">${icon('grip', 14)}</span>
        <div class="brand">${icon('logo', 18)}<div class="header-copy"><h2 class="header-title">工具箱</h2><span class="header-version"></span></div></div>
        <div class="mini-summary" role="status" aria-live="polite"><strong data-task-label></strong><small data-task-detail></small></div>
        <button class="mini-task button primary" data-action="task" type="button" hidden><span data-task-icon></span><span data-task-action></span></button>
        <button class="icon-button" data-action="toggle" type="button" aria-controls="cx-toolbox-workspace" aria-expanded="false" aria-label="展开工具箱" title="展开工具箱">${icon('expand', 14)}</button>
        <button class="icon-button" data-action="more" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" aria-controls="cx-toolbox-menu" title="更多操作">${icon('more', 18)}</button>
      </header>
      <div class="drawer">
        ${singleWorkspace ? '' : `<div class="toolbox-navigation" role="group" aria-label="工具箱快捷导航">
          <button class="toolbox-action" data-action="paste" type="button" title="允许粘贴" aria-label="切换允许粘贴" aria-pressed="false" disabled>${icon('paste', 16)}</button>
          <nav class="toolbox-tabs" role="tablist" aria-label="工具箱功能">${workspaces.map((workspace) => `<button id="cx-tab-${workspace.id}" class="toolbox-tab" role="tab" aria-controls="cx-view-${workspace.id}" data-view="${workspace.id}" type="button" title="${workspace.title}" aria-label="打开${workspace.title}">${icon(workspace.icon, 16)}<span class="tab-label">${workspace.title}</span></button>`).join('')}</nav>
          <button class="toolbox-action" data-action="settings" type="button" title="全局设置" aria-label="打开全局设置">${icon('settings', 16)}</button>
        </div>`}
        <div class="body" id="cx-toolbox-workspace" hidden>
          <div class="status-row"><span class="eyebrow" data-status role="status" aria-live="polite">正在读取设置…</span><label class="switch-label"><span>启用工具箱</span><input type="checkbox" role="switch" class="switch" data-setting="enabled" aria-label="启用工具箱" disabled></label></div>
          <div data-workspaces></div>
          <p class="shell-message" role="status" aria-live="polite" hidden></p>
          <footer class="footer"><p class="privacy-note">题目与回答仅保留在本页内存。</p><button class="icon-button" data-action="reset" type="button" title="复位位置" aria-label="复位工具箱位置">${icon('reset')}</button></footer>
        </div>
        <div class="action-dock" aria-label="当前任务操作"></div>
        <div class="mini"><p class="mini-notice" role="status" aria-live="polite" hidden></p></div>
      </div>
    </section>
    <div id="cx-toolbox-menu" class="more-menu" role="menu" aria-label="工具箱更多操作" hidden>
      <button type="button" role="menuitem" data-action="hide">${icon('hide', 16)}隐藏为悬浮点</button>
      <button type="button" role="menuitem" data-action="settings">${icon('settings', 16)}设置</button>
      <button type="button" role="menuitem" data-action="reset">${icon('reset', 16)}复位位置</button>
      ${platform.id === 'chaoxing' ? `<button type="button" role="menuitemcheckbox" aria-checked="false" data-action="paste">${icon('paste', 16)}<span>允许粘贴</span></button>` : ''}
    </div>`;
  shadow.append(style, root);
  const find = <T extends HTMLElement>(selector: string): T => {
    const value = root.querySelector<T>(selector);
    if (!value) throw new Error(`Missing toolbox element: ${selector}`);
    return value;
  };
  const body = find<HTMLElement>('.body');
  const mini = find<HTMLElement>('.mini');
  const header = find<HTMLElement>('.header');
  const drawer = find<HTMLElement>('.drawer');
  const actionDock = find<HTMLElement>('.action-dock');
  const toggle = find<HTMLButtonElement>('[data-action="toggle"]');
  const dot = find<HTMLButtonElement>('.floating-dot');
  const master = find<HTMLInputElement>('[data-setting="enabled"]');
  const pasteShortcuts = [...root.querySelectorAll<HTMLButtonElement>('[data-action="paste"]')];
  const more = find<HTMLButtonElement>('[data-action="more"]');
  const menu = find<HTMLElement>('.more-menu');
  const taskButton = find<HTMLButtonElement>('[data-action="task"]');
  const status = find<HTMLElement>('[data-status]');
  const notice = find<HTMLElement>('.shell-message');
  const miniNotice = find<HTMLElement>('.mini-notice');
  const aiIcon = root.querySelector<HTMLButtonElement>('[data-view="answer"]');
  find('.header-title').textContent = `工具箱 · ${platform.label}`;
  find('.panel').setAttribute('aria-label', `学习工具箱 · ${platform.label}`);
  find('.header-version').textContent = `v${dependencies.version}`;
  find('.header-version').title = `当前版本 v${dependencies.version}`;
  let settings = dependencies.getSettings();
  let minimized = true;
  let pageContext = readPageContext(document);
  let activeView = resolveSceneWorkspace(platform.id, pageContext);
  let saving = false;
  let disposed = false;
  let settingsRevision = 0;
  let observer: MutationObserver | undefined;
  let renderedMinimized: boolean | undefined;
  let renderedView: ToolboxView | undefined;
  let drawerAnimation: Animation | undefined;

  function renderTask(): void {
    if (disposed) return;
    const task = describeToolboxTask(activeView, dependencies);
    const enabled = Boolean(settings?.enabled);
    host.dataset.taskState = enabled ? task.tone : 'idle';
    const setText = (selector: string, value: string) => { const element = find(selector); if (element.textContent !== value) element.textContent = value; };
    setText('[data-task-label]', enabled ? task.label : settings ? '未启用' : '读取设置…');
    setText('[data-task-detail]', enabled ? task.detail : '展开查看设置');
    find('.mini-summary').title = enabled ? task.message : '展开工具箱启用功能。';
    taskButton.hidden = !enabled || !task.action;
    taskButton.disabled = saving || !task.action;
    if (task.action) {
      setText('[data-task-action]', task.action.label);
      const iconHost = find('[data-task-icon]');
      if (iconHost.dataset.icon !== task.action.icon) { iconHost.innerHTML = icon(task.action.icon, 14); iconHost.dataset.icon = task.action.icon; }
      taskButton.title = `${task.action.label}当前插件任务；收起和展开不会改变任务状态`;
    }
    dot.title = `${enabled ? `${task.label} · ${task.detail}` : '工具箱未启用'}\n点击恢复隐藏前的显示状态；拖动调整位置`;
    dot.setAttribute('aria-label', `${enabled ? task.label : '未启用'}，点击恢复工具箱`);
    find('.dot-state').textContent = !enabled ? '·' : task.tone === 'attention' ? '!' : task.tone === 'paused' ? 'Ⅱ' : task.tone === 'running' ? '▶' : '·';
  }

  function closeMenu(focus = false): void {
    if (menu.hidden) return;
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    if (focus) more.focus({ preventScroll: true });
  }

  function tell(text: string, error = false): void {
    if (disposed) return;
    notice.textContent = text;
    notice.dataset.kind = error ? 'error' : 'success';
    notice.hidden = !text;
    miniNotice.textContent = text;
    miniNotice.style.color = error ? '#b91c1c' : '#0f766e';
    miniNotice.hidden = !text;
  }

  async function saveSettings(update: (current: Settings) => Settings): Promise<void> {
    if (!settings || saving || disposed) throw new Error('设置暂未就绪，请稍后重试。');
    const previous = settings;
    const startRevision = settingsRevision;
    settings = update(settings);
    saving = true;
    tell('');
    render();
    try {
      await dependencies.saveSettings(update);
      settings = dependencies.getSettings() ?? settings;
      tell('设置已保存。');
    } catch (error) {
      if (settingsRevision === startRevision) settings = previous;
      tell('设置保存失败，已保留原设置。', true);
      throw error;
    } finally { saving = false; render(); }
  }

  const views = new Map<ToolboxView, WorkspaceView>();
  let renderedContext = pageContext;
  function ensureView(): WorkspaceView {
    if (renderedContext !== pageContext || !views.has(activeView)) {
      // View disposal only removes UI subscriptions; shared controllers keep running.
      for (const view of views.values()) view.dispose();
      views.clear();
      actionDock.replaceChildren();
      const workspace = workspaces.find(value => value.id === activeView)!;
      const view = workspace.create({
        getSettings: () => settings, saveSettings, extract: dependencies.extract,
        getApiStatus: dependencies.getApiStatus, openSettings: dependencies.openSettings,
        ai: dependencies.ai, questionAnswer: dependencies.questionAnswer, study: dependencies.study, zjoocStudy: dependencies.zjoocStudy,
      });
      view.element.id = `cx-view-${activeView}`;
      if (!singleWorkspace) {
        view.element.setAttribute('role', 'tabpanel');
        view.element.setAttribute('aria-labelledby', `cx-tab-${activeView}`);
      }
      views.set(activeView, view);
      renderedContext = pageContext;
      find('[data-workspaces]').append(view.element);
      if (view.actions) actionDock.append(view.actions);
    }
    return views.get(activeView)!;
  }
  const container = installFloatingContainer({
    host, surface: find('.panel'), content: drawer,
    handles: [...root.querySelectorAll<HTMLElement>('[data-drag-handle]')],
    persistence: { read: dependencies.loadUiPreferences, write: dependencies.saveUiPreferences },
    onHiddenChange(value) { if (value) closeMenu(); },
    onModeChange(value) {
      const opening = minimized && !value;
      minimized = value; render();
      if (opening) views.get(activeView)?.refresh?.();
    },
    onError: message => tell(message, true),
  });

  function render(): void {
    if (disposed) return;
    const modeChanged = renderedMinimized !== undefined && renderedMinimized !== minimized;
    const viewChanged = renderedView !== activeView;
    body.hidden = minimized;
    mini.hidden = !minimized;
    if (renderedMinimized !== minimized) {
      toggle.innerHTML = icon(minimized ? 'expand' : 'minimize', 14) + (minimized ? '<span>展开</span>' : '');
      toggle.setAttribute('aria-expanded', String(!minimized));
      toggle.setAttribute('aria-label', minimized ? '展开工具箱' : '最小化工具箱');
      toggle.title = minimized ? '展开工具箱' : '最小化为迷你控制条';
    }
    renderedMinimized = minimized;
    master.checked = Boolean(settings?.enabled);
    master.disabled = !settings || saving;
    for (const pasteShortcut of pasteShortcuts) {
      pasteShortcut.disabled = platform.id !== 'chaoxing' || !settings?.enabled || saving;
      const attribute = pasteShortcut.getAttribute('role') === 'menuitemcheckbox' ? 'aria-checked' : 'aria-pressed';
      pasteShortcut.setAttribute(attribute, String(Boolean(settings?.enabled && settings.features['allow-paste'])));
      pasteShortcut.title = settings?.enabled && settings.features['allow-paste'] ? '允许粘贴：已开启' : '允许粘贴：已关闭';
    }
    status.textContent = saving ? '正在保存…' : !settings ? '正在读取设置…' : settings.enabled ? '工具箱已开启' : '工具箱已暂停';
    status.dataset.state = saving ? 'saving' : !settings ? 'loading' : settings.enabled ? 'enabled' : 'paused';
    const navigation = root.querySelector<HTMLElement>('.toolbox-navigation');
    if (navigation) navigation.hidden = getWorkspaces(platform.id, pageContext).length <= 1;
    renderTask();
    find('.privacy-note').textContent = activeView === 'zjooc-study' || activeView === 'chapter-study'
      ? '自动学习沿当前课程继续，完成情况以平台确认为准。' : '仅处理当前已加载题目，平台保存状态需单独确认。';
    for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      const descriptor = workspaces.find((workspace) => workspace.id === tab.dataset.view)!;
      tab.hidden = Boolean(descriptor.visibleOnPage && !descriptor.visibleOnPage(pageContext));
      const title = descriptor.titleOnPage?.(pageContext) ?? descriptor.title;
      tab.querySelector<HTMLElement>('.tab-label')!.textContent = title;
      tab.title = title;
      tab.setAttribute('aria-label', `打开${title}`);
      const selected = tab.dataset.view === activeView;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const view = ensureView();
    view.updatePage?.(pageContext);
    view.update(settings, saving);
    if (viewChanged) body.scrollTop = 0;
    renderedView = activeView;
    if (modeChanged) {
      drawerAnimation?.cancel();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof drawer.animate === 'function') {
        // Animate only the incoming workspace; the shared title never transforms.
        drawerAnimation = drawer.animate([
          { opacity: 0, transform: 'translateY(-6px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], { duration: 180, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
      }
    }
  }

  function open(view?: ToolboxViewRequest, focus = true): void {
    if (disposed || !platform) return;
    closeMenu();
    const requested = normalizeToolboxView(view);
    activeView = resolveSceneWorkspace(platform.id, pageContext, requested);
    mount();
    render();
    if (view === 'question-extract' || (requested === 'page-tools' && activeView !== 'page-tools')) {
      const tools = views.get(activeView)?.element.querySelector<HTMLDetailsElement>('.scene-tools');
      if (tools?.querySelector('[aria-label="题目提取"]')) tools.open = true;
    }
    const alreadyOpen = !minimized;
    container.setHidden(false);
    container.setMode(false);
    if (alreadyOpen) views.get(activeView)?.refresh?.();
    if (focus) header.focus({ preventScroll: true });
  }

  function minimize(): void {
    closeMenu();
    container.setMode(true);
    toggle.focus({ preventScroll: true });
  }

  function togglePaste(): void {
    if (platform?.id !== 'chaoxing' || !settings?.enabled || saving) return;
    void saveSettings((current) => ({ ...current, features: { ...current.features, 'allow-paste': !current.features['allow-paste'] } })).catch(() => undefined);
  }
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLButtonElement>('button');
    if (!target || target.disabled) return;
    const requestedTab = workspaces.find((workspace) => workspace.id === target.dataset.view);
    if (requestedTab) open(requestedTab.id, false);
    if (target.dataset.action === 'more') {
      const opening = menu.hidden;
      menu.hidden = !opening;
      more.setAttribute('aria-expanded', String(opening));
      if (opening) {
        menu.dataset.up = 'false';
        menu.dataset.up = String(menu.getBoundingClientRect().bottom > window.innerHeight - 12);
        menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
      }
      return;
    }
    if (target.closest('.more-menu')) closeMenu(true);
    if (target.dataset.action === 'task') { if (settings?.enabled && !saving) describeToolboxTask(activeView, dependencies).action?.run(); return; }
    if (target.dataset.action === 'hide') { container.setHidden(true); dot.focus({ preventScroll: true }); }
    if (target.dataset.action === 'restore') { container.setHidden(false); header.focus({ preventScroll: true }); }
    if (target.dataset.action === 'toggle') { if (minimized) open(); else minimize(); }
    if (target.dataset.action === 'reset') container.resetPosition();
    if (target.dataset.action === 'paste') togglePaste();
    if (target.dataset.action === 'settings') {
      void dependencies.openSettings('features').catch(() => tell('无法打开全局设置，请重新加载扩展。', true));
    }
  }, { signal });
  master.addEventListener('change', () => {
    const enabled = master.checked;
    void saveSettings((current) => ({ ...current, enabled })).catch(() => undefined);
  }, { signal });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (event.key === 'Tab' && !menu.hidden) { closeMenu(true); return; }
    if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(shadow.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true }); return;
    }
    if (event.key === 'Escape' && !minimized) { event.preventDefault(); event.stopPropagation(); minimize(); }
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('[role="tab"]')) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const visible = getWorkspaces(platform.id, pageContext);
    const current = visible.findIndex((workspace) => workspace.id === activeView);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (current + direction + visible.length) % visible.length;
    const view = visible[index].id;
    open(view, false);
    root.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)?.focus({ preventScroll: true });
  }, { signal });
  document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(host)) closeMenu(); }, { signal });
  window.addEventListener('popstate', () => {
    pageContext = readPageContext(document);
    activeView = resolveSceneWorkspace(platform.id, pageContext);
    render();
    if (!minimized) views.get(activeView)?.refresh?.();
  }, { signal });
  const unsubscribeAi = aiIcon ? dependencies.ai?.subscribe((state) => { aiIcon.dataset.running = String(state.running); }) : undefined;
  const taskSubscriptions = [dependencies.study, dependencies.zjoocStudy, dependencies.questionAnswer, dependencies.ai]
    .flatMap(controller => controller ? [controller.subscribe(renderTask)] : []);
  const unsubscribePage = observePageContext(document, (context) => {
    pageContext = context;
    activeView = resolveSceneWorkspace(platform.id, pageContext);
    render();
    if (!minimized) views.get(activeView)?.refresh?.();
  });

  function mount(): void {
    if (disposed || host.isConnected || !document.body) return;
    document.body.append(host);
    observer?.disconnect();
    render();
    container.layout();
  }
  const controller: FloatingPanelController = {
    update(value) { if (!disposed) { settingsRevision += 1; settings = value; render(); if (!minimized) views.get(activeView)?.refresh?.(); } },
    updatePreferences(value) {
      if (disposed) return;
      container.applySnapshot(value);
    },
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      observer?.disconnect();
      unsubscribeAi?.();
      for (const unsubscribe of taskSubscriptions) unsubscribe();
      unsubscribePage?.();
      drawerAnimation?.cancel();
      container.dispose();
      for (const view of views.values()) view.dispose();
      host.remove();
      if (activePanel === controller) activePanel = undefined;
    },
  };
  activePanel = controller;
  if (document.body) mount();
  else {
    observer = new MutationObserver(mount);
    observer.observe(document.documentElement ?? document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', mount, { once: true, signal });
  }
  return controller;
}
