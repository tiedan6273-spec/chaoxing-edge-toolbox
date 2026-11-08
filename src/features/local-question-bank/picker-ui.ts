import { getLibraryState, saveLibraryPreferences, subscribeLibraries } from './library-client';
import type { LibraryState } from './library-types';

/** The page stores only the chosen IDs; full files and library contents stay in the extension. */
export function createLocalBankPicker(openManager: () => void) {
  const element = document.createElement('details'); element.className = 'answer-local-bank';
  element.innerHTML = `<summary>本地题库辅助</summary><div class="answer-local-bank-body"><label><input type="checkbox" data-local="enabled">先查本地题库</label><label><input type="checkbox" data-local="fallback">未匹配时使用所选在线来源</label><p class="editor-hint">本地查询不调用 AI。选中下方题库后保存；完整匹配才可填写，冲突需核对。</p><div class="answer-local-bank-list"></div><div class="answer-settings-actions"><button type="button" class="button" data-local="save">保存题库选择</button><button type="button" class="button" data-local="manage">管理 / 导入题库</button></div><p role="status" class="editor-hint"></p></div>`;
  const enabled = element.querySelector<HTMLInputElement>('[data-local=enabled]')!;
  const fallback = element.querySelector<HTMLInputElement>('[data-local=fallback]')!;
  const list = element.querySelector<HTMLDivElement>('.answer-local-bank-list')!;
  const status = element.querySelector<HTMLElement>('[role=status]')!;
  const save = element.querySelector<HTMLButtonElement>('[data-local=save]')!;
  const manage = element.querySelector<HTMLButtonElement>('[data-local=manage]')!;
  let disposed = false; let loading = false; let allowed = true; let state: LibraryState | undefined; let revision = 0;
  function controls() { for (const input of element.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) input.disabled = !allowed || loading; manage.disabled = false; }
  async function refresh() {
    const current = ++revision; loading = true; controls();
    try {
      const value = await getLibraryState(); if (disposed || current !== revision) return; state = value;
      enabled.checked = value.preferences.enabled; fallback.checked = value.preferences.onlineFallback; list.replaceChildren();
      const active = value.libraries.filter(lib => lib.enabled && lib.count > 0);
      for (const lib of active) {
        const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; check.value = lib.id;
        check.checked = value.preferences.libraryIds.includes(lib.id); label.append(check, document.createTextNode(`${lib.name} · ${lib.count} 题${lib.course ? ` · ${lib.course}` : ''}`)); list.append(label);
      }
      element.querySelector('summary')!.textContent = `本地题库辅助 · 已选 ${active.filter(lib => value.preferences.libraryIds.includes(lib.id)).length} 库`;
      status.textContent = active.length ? '按当前课程保存；无法确认课程时按当前页面单独选库，请核对本次考试适用的题库。' : '暂无可用题库，请先管理 / 导入题库。';
    } catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : '本地题库状态读取失败。'; }
    finally { if (!disposed && current === revision) { loading = false; controls(); } }
  }
  save.addEventListener('click', () => {
    if (loading || !allowed || !state) return;
    const prefs = { enabled: enabled.checked, onlineFallback: fallback.checked,
      libraryIds: [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(check => check.value) };
    loading = true; controls();
    void saveLibraryPreferences(prefs).then(async () => { if (!disposed) { status.textContent = '题库选择已保存；不会自动启动答题。'; await refresh(); } })
      .catch(error => { if (!disposed) status.textContent = error instanceof Error ? error.message : '保存失败。'; })
      .finally(() => { if (!disposed) { loading = false; controls(); } });
  });
  manage.addEventListener('click', openManager);
  const unsubscribe = subscribeLibraries(() => { void refresh(); }); void refresh();
  return { element, update(canChange: boolean) { allowed = canChange; controls(); }, dispose() { disposed = true; revision++; unsubscribe(); element.remove(); } };
}
