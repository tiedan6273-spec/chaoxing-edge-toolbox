export interface Diagnosis { code: string; title: string; help: string; settings?: boolean }
export function diagnose(message: string, fallback = false): Diagnosis | undefined {
  if (/预算|费用未知/.test(message)) return { code: 'AI_BUDGET', title: 'AI 预算需处理', help: '检查本轮用量与价格。确认账单后可开始新一轮统计，再返回继续。', settings: true };
  if (/登录|验证码|验证后|安全验证/.test(message)) return { code: 'PAGE_AUTH', title: '平台需要你操作', help: '在原网页完成登录或验证后，重新识别或继续当前任务。' };
  if (/API|接口|模型|限流|额度|Key|Token|网络请求/.test(message)) return { code: 'PROVIDER', title: '答案来源不可用', help: '检查接口授权、模型与额度；处理后可重试失败题，已有结果保留。', settings: true };
  if (/已更换|已变化|发生变化|页面已切换|起点.*缺少|目录.*变化/.test(message)) return { code: 'PAGE_CHANGED', title: '当前页面需要重新核对', help: '确认课程、题目及起点，再重新识别。人工修改的答案会保留。' };
  if (/平台.*确认|待平台确认|尚未确认|保存.*失败|提交结果|操作结果/.test(message)) return { code: 'PLATFORM_UNCONFIRMED', title: '等待平台确认', help: '检查原网页进度或保存提示。工具箱处理完成与平台确认分别计算；请勿因等待而重复交卷。' };
  if (/自动播放|手动播放|无法播放|播放.*错误|视频暂时停止/.test(message)) return { code: 'MEDIA_BLOCKED', title: '播放器需要检查', help: '定位播放器，手动播放一次并检查网络；需要接管时先暂停工具箱。' };
  if (/课件.*加载|课件.*渲染|阅读.*加载|播放器.*加载|视频.*加载|缓冲|等待课件就绪/.test(message)) return { code: 'RESOURCE_LOADING', title: '资源尚未就绪', help: '定位视频或课件，检查是否实际显示内容。连续失败会暂停，处理后再继续。' };
  if (/连接.*断开|连接已失效|后台.*重启/.test(message)) return { code: 'EXTENSION_CONNECTION', title: '扩展连接中断', help: '先导出当前结果，再刷新网页；更新扩展后需重载扩展并刷新网页。' };
  if (/超时|失败|不支持|未就绪/.test(message) || fallback) return { code: 'NEEDS_ATTENTION', title: '当前步骤需要检查', help: '核对原网页与当前提示，再重新识别或重试。已获取的结果可以先导出。' };
}
export function createDiagnosticView(actions: { recheck?(): void; settings?(): void; locate?(): void }) {
  const element = document.createElement('div'); element.className = 'activity-diagnostic'; element.hidden = true;
  element.innerHTML = '<strong></strong><p></p><div class="activity-buttons"></div>';
  const buttons = element.querySelector('div')!;
  const add = (text: string, action?: () => void) => { if (action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = text; button.addEventListener('click', action); buttons.append(button); return button; } };
  const recheck = add('重新识别', actions.recheck); const settings = add('检查来源与预算', actions.settings);
  add('定位当前内容', actions.locate);
  return { element, update(message: string, fallback = false, busy = false) {
    const diagnosis = diagnose(message, fallback); element.hidden = !diagnosis;
    if (!diagnosis) return;
    element.dataset.diagnostic = diagnosis.code;
    element.querySelector('strong')!.textContent = diagnosis.title;
    element.querySelector('p')!.textContent = diagnosis.help;
    if (settings) settings.hidden = !diagnosis.settings;
    if (recheck) recheck.disabled = busy;
  } };
}
/** Only scroll the native page into view; never click a completion or navigation control. */
export function locateLearningContent(): void {
  const nodes = document.querySelectorAll<HTMLElement>('video, audio, embed, object, iframe');
  const visible = Array.from(nodes).find(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
  visible?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
