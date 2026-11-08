import type { StoredEntry } from './library-types';
import { editLibraryEntry, getEntryHistory, undoLibraryEntry } from './library-client';
import { parseBankTemplate, serializeBankTemplate } from './template';

export function openEntryEditor(entry: StoredEntry, trigger: HTMLElement, saved: () => Promise<void>): void {
  const dialog = document.createElement('dialog'); dialog.className = 'library-editor';
  dialog.setAttribute('aria-label', `编辑题目 ${entry.number}`);
  const title = document.createElement('h2'); title.textContent = `编辑题目 ${entry.number}`;
  const help = document.createElement('p'); help.textContent = '可修改题干、选项、答案和解析。保留字段名称及题目边界；保存前会校验题型与答案。';
  const text = document.createElement('textarea'); text.rows = 20; text.spellcheck = false; text.setAttribute('aria-label', '题目编辑内容');
  text.value = serializeBankTemplate([entry], '单题编辑'); const initial = text.value;
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'library-toolbar'; let busy = false;
  const button = (label: string, run: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = run; return b; };
  const close = () => { if (busy) return; if (text.value !== initial && !window.confirm('放弃尚未保存的修改？')) return; dialog.remove(); trigger.focus(); };
  const commit = button('保存修改', () => { void execute(async () => {
    const draft = parseBankTemplate(text.value);
    if (draft.issues.length || draft.items.length !== 1) throw new Error(draft.issues.map(i => `${i.position}：${i.message}`).join('\n') || '每次只编辑一道题。');
    draft.items[0].position = entry.position;
    await editLibraryEntry(entry.id, entry.version ?? 1, draft.items[0]); await saved(); dialog.remove(); trigger.focus();
  }); });
  const undo = button('撤销最近修改', () => { if (!window.confirm('将最近一次修改撤销为新版本？')) return; void execute(async () => { await undoLibraryEntry(entry.id, entry.version ?? 1); await saved(); dialog.remove(); trigger.focus(); }); });
  async function execute(run: () => Promise<void>) {
    if (busy) return; busy = true; commit.disabled = undo.disabled = text.disabled = true;
    try { await run(); } catch (e) { status.textContent = e instanceof Error ? e.message : '保存失败，草稿已保留。'; }
    finally { busy = false; commit.disabled = undo.disabled = text.disabled = false; }
  }
  const history = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '修改记录'; history.append(summary);
  void getEntryHistory(entry.id).then(items => { undo.hidden = !items.length; for (const item of items) { const line = document.createElement('p'); line.textContent = `${new Date(item.changedAt).toLocaleString('zh-CN')} · 原版本 ${item.version}`; history.append(line); } }).catch(() => { undo.hidden = true; });
  actions.append(commit, undo, button('取消', close)); dialog.append(title, help, text, status, history, actions);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); }); document.body.append(dialog); dialog.showModal(); text.focus();
}
