import { requestExtension } from '../../core/extension-rpc';
import type { ActivitySettings, ActivityStatus } from './types';
import { createUsageRing } from './ring';
import { createUsageDashboard } from './dashboard';

export function usageSummary(status: ActivityStatus): string {
  const l = status.ledger;
  return `本轮 AI ${l.requests} 次 · 输入 ${l.input} / 输出 ${l.output} Token（缓存 ${l.cached}，思考 ${l.reasoning}）\n已知预计费用 ¥${l.cost.toFixed(4)}${l.unknown ? `；另有 ${l.unknown} 次费用未知` : ''}${l.pending.length ? `；进行中 ${l.pending.length} 次` : ''}${status.settings.budget ? `；预算 ¥${status.settings.budget}` : ''}。`;
}
export function createUsageView(openSettings: () => void) {
  const element = document.createElement('details'); element.className = 'answer-configuration activity-usage';
  element.innerHTML = '<summary>AI 用量与预算</summary><div class="answer-configuration-content"><p role="status"></p><button type="button" class="button" data-usage="refresh">刷新统计</button> <button type="button" class="button" data-usage="settings">价格与预算设置</button><p class="editor-hint">所有页面共用本轮统计；本地题库不调用 AI。金额按自填单价估算，以服务商账单为准。</p></div>';
  const text = element.querySelector('p')!; let disposed = false; let reading = false;
  const gauge = createUsageRing(); element.querySelector('.answer-configuration-content')!.prepend(gauge.element);
  async function refresh() {
    if (disposed || reading || !element.open) return;
    reading = true;
    try { const status = await requestExtension<ActivityStatus>('toolbox:activity:status'); if (!disposed) { text.textContent = usageSummary(status); gauge.update(status); } }
    catch { if (!disposed) { text.textContent = '无法读取用量，请刷新统计或重载扩展。'; gauge.update(); } }
    finally { reading = false; }
  }
  element.addEventListener('toggle', () => { void refresh(); });
  element.querySelector('[data-usage=refresh]')!.addEventListener('click', () => { void refresh(); });
  element.querySelector('[data-usage=settings]')!.addEventListener('click', openSettings);
  return { element, refresh, dispose() { disposed = true; element.remove(); } };
}

export function mountActivitySettings(root: HTMLElement, overviewRoot: HTMLElement = root): () => void {
  const card = document.createElement('details'); card.className = 'card activity-settings';
  card.innerHTML = `<summary class="activity-settings-heading"><span><strong>价格、预算与搜题记录设置</strong><small>按模型设置单价，所有模型共用本轮预算</small></span><span class="settings-expand-hint">展开设置</span></summary>
    <form class="settings-form activity-form">
      <p data-activity="model"></p><p data-activity="usage" role="status"></p>
      <div class="field"><label for="usage-model">为哪个模型设置单价</label><select id="usage-model"></select></div>
      <div class="activity-price-grid">
      <div class="field"><label for="usage-input">未命中缓存的输入单价（元 / 百万 Token）</label><input id="usage-input" type="number" min="0" max="1000000" step="any" placeholder="留空表示价格未知"></div>
      <div class="field"><label for="usage-cached">缓存输入单价（元 / 百万 Token）</label><input id="usage-cached" type="number" min="0" max="1000000" step="any" placeholder="按服务商填写"></div>
      <div class="field"><label for="usage-output">输出单价（元 / 百万 Token）</label><input id="usage-output" type="number" min="0" max="1000000" step="any" placeholder="按服务商填写"></div>
      </div>
      <div class="field"><label for="usage-budget">本轮预计费用预算（元，0 为关闭）</label><input id="usage-budget" type="number" min="0" max="1000000" step="any" value="0" required></div>
      <p class="field-help">单价分别绑定所选接口和模型，其他模型的单价保留。同接口同模型共用价格。更改单价会开始新一轮统计；切换模型优先级保留本轮用量。预算在每次请求前检查，单次请求可能超出阈值；费用未知时暂停后续 AI 请求。连接测试、整卷复检也计入。</p>
      <details class="activity-history-settings"><summary>搜题记录管理</summary><div class="field"><label for="history-days">搜题记录保留期限</label><select id="history-days"><option value="0">关闭并清空</option><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option></select></div><p class="field-help">保存完整纯文本题的参考答案，最多 600 条 / 2 MB。图片题不保存；刷新后需显式恢复。</p></details>
      <div class="button-row"><button type="submit" class="primary">保存记录与预算设置</button><button type="button" class="secondary" data-activity="refresh">重新读取</button></div>
      <div class="button-row"><button type="button" class="secondary" data-activity="reset">开始新一轮统计</button><button type="button" class="text-button" data-activity="clear">清空全部搜题记录</button></div>
      <p data-activity="confirm" hidden>此操作会清空所选本机记录，页面答案保留。<button type="button" class="secondary" data-activity="yes">确认操作</button> <button type="button" class="secondary" data-activity="no">取消</button></p>
      <p data-activity="feedback" class="feedback" role="status"></p>
    </form>`;
  root.append(card);
  const find = <T extends HTMLElement>(selector: string) => card.querySelector<T>(selector)!;
  const form = find<HTMLFormElement>('form'); const days = find<HTMLSelectElement>('#history-days');
  const dashboard = createUsageDashboard(() => { void operation(readOverview); }, () => { card.open = true; find<HTMLInputElement>('#usage-budget').focus(); });
  overviewRoot.prepend(dashboard.element);
  const model = find<HTMLSelectElement>('#usage-model');
  const input = find<HTMLInputElement>('#usage-input'); const cached = find<HTMLInputElement>('#usage-cached');
  const output = find<HTMLInputElement>('#usage-output'); const budget = find<HTMLInputElement>('#usage-budget');
  const feedback = find<HTMLElement>('[data-activity=feedback]'); const confirmation = find<HTMLElement>('[data-activity=confirm]');
  let identity = ''; let disposed = false; let busy = false; let confirm = '';
  const controls = () => Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button'));
  async function operation(action: () => Promise<void>, message = '') {
    if (busy || disposed) return; busy = true; dashboard.loading(true); controls().forEach(e => e.disabled = true); confirmation.hidden = true;
    try { await action(); if (!disposed) feedback.textContent = message; }
    catch (error) { if (!disposed) feedback.textContent = error instanceof Error ? error.message : '操作失败，请重新读取后再试。'; }
    finally { busy = false; if (!disposed) { controls().forEach(e => e.disabled = false); dashboard.loading(false); } }
  }
  async function readOverview() {
    try { const status = await requestExtension<ActivityStatus>('toolbox:activity:status', { identity: model.value || undefined }); if (!disposed) dashboard.update(status); }
    catch (error) { if (!disposed) dashboard.update(undefined, '用量读取失败，请点击刷新用量重试。'); throw error; }
  }
  async function read() {
    const status = await requestExtension<ActivityStatus>('toolbox:activity:status', { identity: model.value || undefined }).catch(error => { if (!disposed) dashboard.update(undefined, '用量读取失败，请点击刷新用量重试。'); throw error; });
    if (disposed) return;
    identity = status.identity;
    dashboard.update(status);
    model.replaceChildren(...(status.models?.length ? status.models : [{ identity, name: '尚未配置', model: '' }]).map(item => { const option = document.createElement('option'); option.value = item.identity; option.textContent = `${item.name}${item.model ? ` · ${item.model}` : ''}`; return option; }));
    model.value = identity;
    find('[data-activity=model]').textContent = `计价模型：${status.model || '尚未配置'}${status.priced ? '' : ' · 单价未配置'}；统计汇总所有模型。`;
    find('[data-activity=usage]').textContent = usageSummary(status);
    days.value = String(status.settings.retentionDays); budget.value = String(status.settings.budget);
    input.value = status.priced ? String(status.settings.pricing!.input) : '';
    cached.value = status.priced ? String(status.settings.pricing!.cached) : '';
    output.value = status.priced ? String(status.settings.pricing!.output) : '';
    find<HTMLButtonElement>('[data-activity=clear]').title = `本机共 ${status.historyCount} 条记录`;
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = [input.value, cached.value, output.value];
    if (values.some(Boolean) && !values.every(Boolean)) { feedback.textContent = '请完整填写三项单价，或全部留空。'; return; }
    const settings: ActivitySettings = { retentionDays: Number(days.value) as ActivitySettings['retentionDays'], budget: Number(budget.value),
      ...(values.every(Boolean) ? { pricing: { identity, input: Number(input.value), cached: Number(cached.value), output: Number(output.value) } } : {}) };
    void operation(async () => { await requestExtension('toolbox:activity:save', { settings, identity }); await read(); }, '已保存。');
  });
  model.addEventListener('change', () => { void operation(read, '已切换计价模型，请填写并保存单价。'); });
  const modelsChanged = () => { if (!disposed) feedback.textContent = '模型列表已更新，请点击“重新读取”后选择要计价的模型。'; };
  const apiScope = root.closest('#settings-api') ?? root;
  const usageChanged = () => { if (!busy && !disposed) void readOverview().catch(() => {}); };
  apiScope.addEventListener('api-models-saved', modelsChanged); apiScope.addEventListener('api-usage-updated', usageChanged);
  find('[data-activity=refresh]').addEventListener('click', () => { void operation(read, '已重新读取。'); });
  for (const action of ['reset', 'clear']) find(`[data-activity=${action}]`).addEventListener('click', () => {
    confirm = action;
    confirmation.firstChild!.textContent = action === 'reset' ? '开始新一轮将清空当前用量统计并重新计算预算，搜题记录保留。' : '将清空全部本机搜题记录，页面答案与用量统计保留。';
    confirmation.hidden = false;
  });
  find('[data-activity=no]').addEventListener('click', () => { confirmation.hidden = true; confirm = ''; });
  find('[data-activity=yes]').addEventListener('click', () => { if (confirm) void operation(async () => { await requestExtension(`toolbox:activity:${confirm}`); await read(); }, '操作已完成。'); });
  void operation(read);
  return () => { disposed = true; apiScope.removeEventListener('api-models-saved', modelsChanged); apiScope.removeEventListener('api-usage-updated', usageChanged); dashboard.element.remove(); card.remove(); };
}
