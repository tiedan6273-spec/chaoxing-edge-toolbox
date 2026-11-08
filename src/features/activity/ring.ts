import type { ActivityStatus } from './types';

export function usageRingState(status: ActivityStatus) {
  const budget = status.settings.budget; const cost = status.ledger.cost;
  const ratio = budget > 0 ? cost / budget : 0;
  const unknown = status.ledger.unknown > 0; const pending = status.ledger.pending.length;
  const percent = ratio * 100;
  const label = budget <= 0 ? '未设预算' : unknown ? (cost ? `≥${percent.toFixed(0)}%` : '待核对') : `${percent.toFixed(percent > 0 && percent < 1 ? 1 : 0)}%`;
  const detail = `已知预计费用 ¥${cost.toFixed(4)}${budget > 0 ? ` / 预算 ¥${budget}` : '；设置预算后显示比例'}${ratio >= 1 ? '；已达预算' : ''}${unknown ? `；${status.ledger.unknown} 次费用未知，实际占比待核对` : ''}${pending ? `；${pending} 次请求进行中` : ''}。`;
  return { ratio: Math.min(1, Math.max(0, ratio)), label, detail,
    state: unknown ? 'unknown' : ratio >= 1 ? 'exceeded' : ratio >= 0.8 ? 'warning' : budget <= 0 ? 'unset' : 'normal' };
}

/** A local budget graphic, not an account balance or provider quota. */
export function createUsageRing() {
  const element = document.createElement('div'); element.className = 'usage-gauge';
  element.innerHTML = '<div class="usage-ring" role="img"><svg viewBox="0 0 80 80" aria-hidden="true" focusable="false"><circle class="usage-ring-track" cx="40" cy="40" r="32"/><circle class="usage-ring-fill" cx="40" cy="40" r="32" pathLength="100" transform="rotate(-90 40 40)"/></svg><strong class="usage-ring-label">读取中</strong></div><div class="usage-ring-caption"><strong>本轮预算使用</strong><p></p><small>按自填单价估算</small></div>';
  const ring = element.querySelector<HTMLElement>('.usage-ring')!;
  const fill = element.querySelector<SVGCircleElement>('.usage-ring-fill')!;
  const label = element.querySelector<HTMLElement>('.usage-ring-label')!;
  const detail = element.querySelector('p')!;
  function update(status?: ActivityStatus) {
    const v = status ? usageRingState(status) : { state: 'unavailable', ratio: 0, label: '待更新', detail: '用量尚未读取，请刷新统计。' };
    element.dataset.state = v.state;
    fill.setAttribute('stroke-dasharray', `${v.ratio * 100} 100`);
    label.textContent = v.label; detail.textContent = v.detail;
    ring.setAttribute('aria-label', `${v.label}，${v.detail}`);
  }
  update(); return { element, update };
}
