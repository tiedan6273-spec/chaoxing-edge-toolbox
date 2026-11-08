import { exportConfigBackup, restoreConfigBackup } from './client';
import { BACKUP_MAX_BYTES, backupOrigins, parseConfigBackup, validateConfigBackup, type ConfigBackup } from './format';

/** Files and credentials never leave this trusted options view except for the user's download. */
export function mountConfigBackup(root: HTMLElement, restored: () => void): () => void {
  root.innerHTML = `<div class="card backup-card">
    <div class="section-heading"><h2>配置备份</h2><p>导出或恢复已保存的 API 和言溪题库配置。</p></div>
    <div class="settings-form">
      <p class="inline-note">JSON 文件包含明文 API Key 和题库 Token，请妥善保存。仅导出已保存配置，不包含题目、答案、功能开关或悬浮框偏好。</p>
      <div class="button-row"><button type="button" class="secondary backup-export">导出配置</button><label class="secondary backup-file-label">选择备份文件<input type="file" class="backup-file" accept=".json,application/json" aria-label="选择配置备份 JSON 文件" /></label></div>
      <div class="backup-preview" hidden><p class="backup-summary"></p><p class="field-help">恢复将覆盖文件中包含的已保存配置及其表单草稿，其他配置保留；正在答题的任务会暂停。</p><div class="button-row"><button type="button" class="primary backup-restore">确认恢复配置</button><button type="button" class="text-button backup-cancel">取消</button></div></div>
      <p class="feedback" role="status" aria-live="polite" hidden></p>
    </div></div>`;
  const file = root.querySelector<HTMLInputElement>('.backup-file')!;
  const exportButton = root.querySelector<HTMLButtonElement>('.backup-export')!;
  const restore = root.querySelector<HTMLButtonElement>('.backup-restore')!;
  const cancel = root.querySelector<HTMLButtonElement>('.backup-cancel')!;
  const preview = root.querySelector<HTMLElement>('.backup-preview')!;
  const summary = root.querySelector<HTMLElement>('.backup-summary')!;
  const feedback = root.querySelector<HTMLElement>('.feedback')!;
  const listeners = new AbortController();
  let pending: ConfigBackup | undefined;
  let busy = false;
  let disposed = false;
  let revision = 0;
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  let downloadUrl: string | undefined;
  function tell(message: string, error = false): void {
    if (disposed) return;
    feedback.textContent = message; feedback.dataset.kind = error ? 'error' : 'success'; feedback.hidden = false;
  }
  function render(): void {
    if (disposed) return;
    file.disabled = exportButton.disabled = restore.disabled = cancel.disabled = busy;
    preview.hidden = !pending;
    root.setAttribute('aria-busy', String(busy));
  }
  function clear(): void { pending = undefined; file.value = ''; summary.textContent = ''; }
  function releaseDownload(): void {
    if (downloadTimer) clearTimeout(downloadTimer);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadTimer = undefined; downloadUrl = undefined;
  }
  exportButton.addEventListener('click', () => {
    if (busy || disposed) return;
    busy = true; render();
    void (async () => {
      try {
        const backup = validateConfigBackup(await exportConfigBackup());
        if (disposed) return;
        releaseDownload();
        downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const link = root.ownerDocument.createElement('a');
        link.href = downloadUrl; link.download = `学习工具箱配置-${backup.exportedAt.slice(0, 10)}.json`;
        root.append(link); link.click(); link.remove();
        downloadTimer = setTimeout(releaseDownload, 1000);
        tell('已导出已保存配置，文件包含明文密钥。');
      } catch (error) {
        const empty = error instanceof Error && error.message === '尚无已保存的 API 或言溪题库配置可以导出。';
        tell(empty ? error.message : '配置导出失败，请确认已有完整的已保存配置后重试。', true);
      }
      finally { busy = false; render(); }
    })();
  }, { signal: listeners.signal });
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    const current = ++revision;
    clear(); render();
    if (!selected || disposed) return;
    busy = true; render();
    void (async () => {
      try {
        if (selected.size > BACKUP_MAX_BYTES) throw new Error('文件过大');
        const parsed = parseConfigBackup(await selected.text());
        if (disposed || current !== revision) return;
        pending = parsed;
        summary.textContent = `将恢复：${[...(parsed.api ? ['API 地址、模型及密钥'] : []), ...(parsed.apiProfiles ? [`${parsed.apiProfiles.profiles.length} 个模型、优先级及密钥`] : []), ...(parsed.questionBank ? ['言溪题库 Token'] : [])].join('；')}。`;
        tell('备份已校验，请确认恢复项目后点击恢复。');
      } catch { if (current === revision) tell('备份文件无效、版本不支持或过大，已有配置未修改。', true); }
      finally { if (current === revision) { busy = false; render(); } }
    })();
  }, { signal: listeners.signal });
  restore.addEventListener('click', () => {
    if (busy || !pending || disposed) return;
    const backup = pending;
    let granted: Promise<boolean>;
    // Invoke before the first await to preserve the click's permission-request gesture.
    try { granted = chrome.permissions.request({ origins: backupOrigins(backup) }); }
    catch { tell('无法申请备份所需权限，已有配置未修改。', true); return; }
    busy = true; render();
    void (async () => {
      try {
        if (!await granted) { tell('未获得所需域名权限，已有配置未修改。', true); return; }
        if (disposed) return;
        await restoreConfigBackup(backup);
        if (disposed) return;
        clear(); restored(); tell('配置已恢复，设置表单已刷新；请重新开始答题。');
      } catch { tell('恢复失败，未完成配置恢复，请检查权限后重试。', true); }
      finally { busy = false; render(); }
    })();
  }, { signal: listeners.signal });
  cancel.addEventListener('click', () => { if (!busy) { ++revision; clear(); feedback.hidden = true; render(); } }, { signal: listeners.signal });
  return () => { disposed = true; ++revision; listeners.abort(); clear(); releaseDownload(); };
}
