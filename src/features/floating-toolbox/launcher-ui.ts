import { getApiStatus } from '../api-settings/client';
import { openSettings } from '../../platform/settings-navigation';
import { getPlatform, isSupportedUrl } from '../../shared/sites';
import { isThinkLadderUrl } from '../ai-answer/adapters/think-ladder';
import { pageContextFromUrl, pageToolsTitle } from '../../platform/page-context';
import { icon } from './icons';

/** Compact launcher only. In-page feature workspaces own question and answer interaction. */
export function mountToolboxLauncher(root: HTMLElement): () => void {
  function element<T extends HTMLElement>(selector: string): T {
    const result = root.querySelector<T>(selector);
    if (!result) throw new Error(`Missing launcher element: ${selector}`);
    return result;
  }
  const openPanelButton = element<HTMLButtonElement>('#open-panel');
  const openSettingsButton = element<HTMLButtonElement>('#open-settings');
  const openApiButton = element<HTMLButtonElement>('#open-api-settings');
  const feedback = element<HTMLElement>('#feedback');
  const pageHint = element<HTMLElement>('#page-hint');
  const pageDetails = element<HTMLElement>('#page-details');
  const panelNote = element<HTMLElement>('#panel-note');
  const apiHint = element<HTMLElement>('#api-hint');
  const apiModel = element<HTMLElement>('#api-model-hint');
  const apiSummary = element<HTMLElement>('.api-summary');
  const brand = root.querySelector('.brand-mark');
  if (brand) brand.innerHTML = icon('logo', 32);
  element<HTMLElement>('#version').textContent = `v${chrome.runtime.getManifest().version}`;
  let opening = false;
  let checking = true;
  let supported = false;
  let needsApi = true;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function tell(message: string, error = false): void {
    if (disposed) return;
    feedback.textContent = message;
    feedback.dataset.kind = error ? 'error' : 'success';
    feedback.hidden = false;
  }
  function render(): void {
    if (disposed) return;
    openPanelButton.disabled = checking || opening || !supported;
    openPanelButton.hidden = checking || !supported;
    openPanelButton.textContent = opening ? '正在打开…' : '打开悬浮工具箱';
    openPanelButton.setAttribute('aria-busy', String(opening));
    panelNote.hidden = checking || supported || !panelNote.textContent;
  }

  async function inspectPage(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (disposed) return;
      const platform = getPlatform(tab?.url);
      supported = Boolean(platform);
      const zjooc = platform?.id === 'zjooc';
      const context = tab?.url ? pageContextFromUrl(tab.url) : 'generic';
      const assessment = context === 'homework' || context === 'exam';
      apiSummary.hidden = context === 'chapter' || zjooc && !assessment;
      const ladder = supported && tab?.url && isThinkLadderUrl(tab.url);
      pageHint.textContent = supported
        ? `${platform!.label} · ${pageToolsTitle(context)}`
        : '当前页面不支持';
      pageDetails.textContent = supported
        ? assessment ? `${zjooc ? '浙学考试为候选适配。' : ''}在答题页识别当前已加载题目，选择来源后处理；填写后请自行检查并保存或交卷。`
          : zjooc ? '在课程学习详情页启用自动学习，视频使用平台最高倍速，并处理课件“完成学习”。'
          : ladder ? '“答题”中生成并填入简答题回答；“思维阶梯”中粘贴、提取题目。'
          : context === 'chapter' ? '章节学习中管理播放参数和测验联动；最小化后仍可暂停和继续。'
            : '可打开页面工具，使用允许粘贴与题目提取，题目以页面识别结果为准。'
        : '请切换到学习通（chaoxing.com）或浙学（www.zjooc.cn）页面。';
      panelNote.textContent = supported ? '' : '工具箱仅在已支持的网站内可用';
      if (!apiSummary.hidden) void inspectApi();
    } catch {
      pageHint.textContent = '无法读取当前页面';
      pageDetails.textContent = '请关闭此窗口后重试。';
      panelNote.textContent = '';
    }
    finally { checking = false; render(); }
  }

  async function inspectApi(): Promise<void> {
    try {
      const status = await getApiStatus();
      needsApi = !status.configured || !status.authorized;
      apiHint.textContent = !status.configured ? '尚未配置' : !status.authorized ? '域名待授权' : '已配置';
      apiHint.dataset.state = needsApi ? 'missing' : 'ready';
      apiModel.textContent = status.model ? `模型：${status.model}` : '仅 AI 作答需要，其他工具可直接使用。';
    } catch {
      needsApi = true;
      apiHint.textContent = '读取失败';
      apiHint.dataset.state = 'missing';
      apiModel.textContent = '进入设置页重新读取或配置。';
    } finally { render(); }
  }

  async function openPanel(): Promise<void> {
    if (openPanelButton.disabled || disposed) return;
    opening = true;
    feedback.hidden = true;
    render();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined || !isSupportedUrl(tab.url)) {
        supported = false;
        pageHint.textContent = '当前页面不支持';
        pageDetails.textContent = '请切换到学习通或浙学页面后再打开。';
        panelNote.textContent = '工具箱仅在已支持的网站内可用';
        return;
      }
      const result: unknown = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: 'toolbox:open-panel' }, { frameId: 0 }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Page unavailable')), 5000); }),
      ]);
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('Page unavailable');
      tell('悬浮工具箱已在网页中打开。');
    } catch { tell('打开失败。请在 edge://extensions 重新加载扩展，再刷新当前学习页面。', true); }
    finally { if (timer !== undefined) clearTimeout(timer); opening = false; render(); }
  }
  const onPanel = () => { void openPanel(); };
  const onSettings = () => {
    void openSettings('features').catch(() => tell('设置页暂时无法打开，请重新加载扩展后重试。', true));
  };
  const onApiSettings = () => {
    void openSettings('api').catch(() => tell('API 设置暂时无法打开，请重新加载扩展后重试。', true));
  };
  openPanelButton.addEventListener('click', onPanel);
  openSettingsButton.addEventListener('click', onSettings);
  openApiButton.addEventListener('click', onApiSettings);
  void inspectPage();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    openPanelButton.removeEventListener('click', onPanel);
    openSettingsButton.removeEventListener('click', onSettings);
    openApiButton.removeEventListener('click', onApiSettings);
  };
}
