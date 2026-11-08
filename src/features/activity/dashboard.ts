import type { ActivityStatus } from './types';
import { createUsageRing } from './ring';

const count = (value: number) => value.toLocaleString('zh-CN');
export function createUsageDashboard(refresh: () => void, settings: () => void) {
  const element = document.createElement('section'); element.className = 'usage-dashboard'; element.setAttribute('aria-label', '用量概览');
  element.innerHTML = `<div class="usage-dashboard-heading"><div><h2>用量概览</h2><p class="usage-period">正在读取本轮统计…</p></div><button type="button" class="secondary dashboard-refresh">刷新用量</button></div>
    <div class="usage-cards"><article class="card usage-budget-card"><div class="usage-card-heading"><h3>本轮费用与预算</h3><span>所有模型合计</span></div><div class="usage-budget-main"><div class="dashboard-ring"></div><dl class="usage-cost-values"><div><dt>已知预计费用</dt><dd data-stat="cost">—</dd></div><div><dt>预算剩余</dt><dd data-stat="remaining">—</dd></div></dl></div><div class="usage-card-footer"><span>本机按自填单价估算</span><button class="text-button dashboard-settings" type="button">设置预算</button></div></article>
    <article class="card usage-tokens-card"><div class="usage-card-heading"><h3>调用与 Token</h3><span class="usage-pending" data-stat="pending"></span></div><div class="usage-token-body"><div class="usage-request-count"><strong data-stat="requests">—</strong><span>次模型请求</span></div><dl class="usage-token-values"><div><dt>输入 Token</dt><dd data-stat="input">—</dd></div><div><dt>输出 Token</dt><dd data-stat="output">—</dd></div></dl><div class="usage-token-bar" aria-hidden="true"><span class="usage-input-bar"></span><span class="usage-output-bar"></span></div><p class="usage-token-details"></p></div><div class="usage-card-footer"><span class="usage-updated">尚未读取</span><span>本地题库不计入</span></div></article></div>
    <p class="dashboard-feedback" role="status" aria-live="polite"></p>`;
  const gauge = createUsageRing(); element.querySelector('.dashboard-ring')!.append(gauge.element);
  const stat = (key: string, value: string) => { element.querySelector(`[data-stat="${key}"]`)!.textContent = value; };
  element.querySelector('.dashboard-refresh')!.addEventListener('click', refresh);
  element.querySelector('.dashboard-settings')!.addEventListener('click', settings);
  return { element,
    loading(value: boolean) { element.querySelector<HTMLButtonElement>('.dashboard-refresh')!.disabled = value; element.setAttribute('aria-busy', String(value)); },
    update(status?: ActivityStatus, error = '') {
      gauge.update(status); element.querySelector('.dashboard-feedback')!.textContent = error;
      if (!status) {
        for (const key of ['cost','remaining','requests','input','output','pending']) stat(key, '—');
        element.querySelector('.usage-period')!.textContent = '本轮统计暂不可用'; element.querySelector('.usage-token-details')!.textContent = '';
        element.querySelector<HTMLElement>('.usage-input-bar')!.style.width = '0%'; element.querySelector<HTMLElement>('.usage-output-bar')!.style.width = '0%';
        element.querySelector('.usage-updated')!.textContent = '尚未读取'; return;
      }
      const { ledger: l, settings: s } = status;
      element.querySelector('.usage-period')!.textContent = `本轮从 ${new Date(l.since).toLocaleString('zh-CN')} 开始`;
      stat('cost', `¥${l.cost.toFixed(4)}`); stat('remaining', s.budget <= 0 ? '未设预算' : l.unknown ? '待核对' : `¥${Math.max(0, s.budget - l.cost).toFixed(4)}`);
      stat('requests', count(l.requests)); stat('input', count(l.input)); stat('output', count(l.output)); stat('pending', l.pending.length ? `${l.pending.length} 次进行中` : '当前无进行中请求');
      const total = l.input + l.output; const share = total ? l.input / total * 100 : 50;
      element.querySelector<HTMLElement>('.usage-input-bar')!.style.width = `${share}%`; element.querySelector<HTMLElement>('.usage-output-bar')!.style.width = `${100 - share}%`;
      element.querySelector('.usage-token-details')!.textContent = `输入含缓存 ${count(l.cached)}；输出含思考 ${count(l.reasoning)}${l.unknown ? ` · ${l.unknown} 次费用待核对` : ''}`;
      element.querySelector('.usage-updated')!.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
    },
  };
}
