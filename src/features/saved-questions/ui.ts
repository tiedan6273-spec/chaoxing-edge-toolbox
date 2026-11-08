import { requestExtension } from '../../core/extension-rpc';
import { formatApplicableAnswer } from '../question-answer/answer-format';
import { downloadResultsFile } from '../question-answer/export-ui';
import { importLibrary } from '../local-question-bank/library-client';
import type { SavedQuestion, SavedQuestionInput } from './types';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
const button = (text: string, run: () => void) => { const b = el('button', text); b.type = 'button'; b.onclick = run; return b; };
export function createSavedActions(read: () => SavedQuestionInput | undefined): HTMLElement {
  const root = el('div'); root.className = 'saved-quick-actions'; const status = el('span'); status.setAttribute('role', 'status'); let busy = false;
  const save = async (wrong: boolean) => {
    const input = read(); if (!input || busy) return; busy = true; favorite.disabled = mistake.disabled = true;
    try { await requestExtension('toolbox:saved:save', { input: { ...input, wrong } }); status.textContent = wrong ? '已标记为错题' : '已收藏'; }
    catch (e) { status.textContent = e instanceof Error ? e.message : '收藏失败，请重试。'; }
    finally { busy = false; favorite.disabled = mistake.disabled = false; }
  };
  const favorite = button('收藏', () => { void save(false); }); const mistake = button('标记错题', () => { void save(true); });
  root.append(favorite, mistake, status); return root;
}
export function mountSavedQuestions(root: HTMLElement): () => void {
  root.className = 'settings-card saved-manager';
  const heading = el('div'); heading.className = 'section-heading'; heading.append(el('h2', '收藏与错题本'));
  const body = el('div'); body.className = 'library-body';
  const help = el('p', '收藏长期保存在本机，独立于搜题历史。AI 差异标记需要核对；只有你标记的题目才进入错题列表。'); help.className = 'field-help';
  const filter = el('input'); filter.type = 'search'; filter.placeholder = '搜索题干、课程、标签或备注'; filter.setAttribute('aria-label', '搜索收藏');
  const kind = el('select'); kind.setAttribute('aria-label', '收藏筛选');
  for (const [value, text] of [['all', '全部收藏'], ['wrong', '错题'], ['review', '待复习'], ['mastered', '已掌握']]) { const o = el('option', text); o.value = value; kind.append(o); }
  const status = el('p'); status.setAttribute('role', 'status'); const list = el('div'); list.className = 'saved-list';
  const toolbar = el('div'); toolbar.className = 'library-toolbar'; const selected = new Set<string>();
  const file = el('input'); file.type = 'file'; file.accept = '.json'; file.setAttribute('aria-label', '选择完整题库与收藏备份');
  const preview = el('div'); preview.hidden = true; let backup: unknown; let disposed = false; let busy = false; let items: SavedQuestion[] = []; let epoch = 0; let page = 0;
  const paging = el('div'); paging.className = 'library-toolbar'; const count = el('span');
  async function act(run: () => Promise<void>) { if (busy) return; busy = true; try { await run(); } catch (e) { status.textContent = e instanceof Error ? e.message : '操作失败，请重试。'; } finally { busy = false; } }
  async function refresh() { const own = ++epoch; const next = await requestExtension<SavedQuestion[]>('toolbox:saved:list'); if (disposed || own !== epoch) return; items = next; render(); }
  const download = (value: unknown, name: string) => downloadResultsFile({ content: JSON.stringify(value), name, mime: 'application/json;charset=utf-8', count: items.length });
  const exportAll = button('备份全部题库与收藏', () => { void act(async () => download(await requestExtension('toolbox:local-libraries:backup'), '学习工具箱-题库与收藏备份.json')); });
  const exportNotes = button('导出收藏 TXT', () => downloadResultsFile({ name: '收藏与错题.txt', mime: 'text/plain;charset=utf-8', count: items.length,
    content: '\uFEFF' + items.map((i, n) => `${n + 1}. ${i.question.stem}\n${i.question.options.map(o => `${o.label}. ${o.text}`).join('\n')}\n参考答案：${i.referenceAnswer ? formatApplicableAnswer(i.question, i.referenceAnswer) : '暂无'}\n我的答案：${i.currentAnswer ? formatApplicableAnswer(i.question, i.currentAnswer) : '暂无'}\n课程：${i.course}\n来源：${i.source}\n标签：${i.tags.join('、')}\n备注：${i.note}\n`).join('\n') }));
  const remove = button('删除勾选收藏', () => { if (!selected.size || !window.confirm(`删除勾选的 ${selected.size} 条收藏？可先导出完整备份。`)) return; void act(async () => { await requestExtension('toolbox:saved:remove', { ids: [...selected] }); selected.clear(); await refresh(); status.textContent = '勾选收藏已删除。'; }); });
  file.onchange = () => { void act(async () => {
    backup = undefined; preview.hidden = true; const chosen = file.files?.[0]; if (!chosen) return;
    if (!chosen.size || chosen.size > 20 * 1024 * 1024) throw new Error('备份应为不超过 20 MB 的 JSON 文件。');
    const data = JSON.parse(await chosen.text()) as { kind?: string; version?: number; libraries?: unknown[]; entries?: unknown[]; saved?: unknown[] };
    if (data.kind !== 'toolbox-library-backup' || data.version !== 2 || !Array.isArray(data.entries) || !Array.isArray(data.libraries) || !Array.isArray(data.saved)) throw new Error('这里需要完整备份；单库旧 JSON 请用上方导入入口。');
    backup = data; preview.hidden = false; preview.replaceChildren(el('p', `备份包含 ${data.libraries.length} 个题库、${data.entries.length} 道题、${data.saved.length} 条收藏。恢复会替换当前题库和收藏，请先备份当前数据。`),
      button('确认替换并恢复', () => { void act(async () => { await requestExtension('toolbox:local-libraries:restore', { backup }); preview.hidden = true; backup = undefined; file.value = ''; await refresh(); status.textContent = '完整备份已恢复；请重新核对课程选库。'; }); }),
      button('取消恢复', () => { backup = undefined; preview.hidden = true; file.value = ''; }));
  }); };
  function render() {
    if (disposed) return; const term = filter.value.toLocaleLowerCase();
    const found = items.filter(i => `${i.question.stem} ${i.course} ${i.note} ${i.tags.join(' ')}`.toLocaleLowerCase().includes(term)
      && (kind.value !== 'wrong' || i.wrong) && (kind.value !== 'review' || !i.mastered) && (kind.value !== 'mastered' || i.mastered));
    const pages = Math.max(1, Math.ceil(found.length / 15)); page = Math.min(page, pages - 1); list.replaceChildren();
    for (const item of found.slice(page * 15, page * 15 + 15)) {
      const card = el('article'); card.className = 'saved-card'; const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(item.id); check.setAttribute('aria-label', `勾选收藏 ${item.question.number}`);
      check.onchange = () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); remove.disabled = !selected.size; };
      const title = el('h3', `${item.wrong ? '错题 · ' : ''}${item.question.stem}`); title.prepend(check);
      const meta = el('p', `${item.course} · ${item.source} · ${item.mastered ? '已掌握' : '待复习'}`); meta.className = 'field-help';
      const details = el('details'); details.append(el('summary', '查看答案与笔记'));
      const q = item.question;
      for (const o of q.options) details.append(el('p', `${o.label}. ${o.text}`));
      if (q.reason) details.append(el('p', q.reason));
      details.append(el('pre', `我的答案：${item.currentAnswer ? formatApplicableAnswer(q, item.currentAnswer) : '暂无'}\n参考答案：${item.referenceAnswer ? formatApplicableAnswer(q, item.referenceAnswer) : '暂无'}`));
      const note = el('textarea'); note.rows = 3; note.value = item.note; note.maxLength = 8000; note.setAttribute('aria-label', '收藏备注');
      const tags = el('input'); tags.value = item.tags.join('，'); tags.placeholder = '标签，用逗号分隔'; tags.setAttribute('aria-label', '收藏标签');
      const actions = el('div'); actions.className = 'library-toolbar';
      actions.append(button('保存笔记', () => { void act(async () => { await requestExtension('toolbox:saved:save', { input: { ...item, note: note.value, tags: tags.value.split(/[,，]/) }, version: item.version }); await refresh(); status.textContent = '笔记已保存。'; }); }),
        button(item.mastered ? '改为待复习' : '标记已掌握', () => { void act(async () => { await requestExtension('toolbox:saved:mastered', { id: item.id, version: item.version, mastered: !item.mastered }); await refresh(); }); }),
        button(item.wrong ? '取消错题标记' : '标记错题', () => { void act(async () => { await requestExtension('toolbox:saved:save', { input: { ...item, wrong: !item.wrong }, version: item.version }); await refresh(); }); }),
        button('将参考答案加入题库', () => { if (!item.referenceAnswer || !window.confirm('确认已核对参考答案，并将此题加入新题库？')) return; void act(async () => {
          await importLibrary({ name: '收藏整理', course: item.course, filename: '', fileHash: `saved:${item.id}:${item.version}`, format: 'saved', items: [{ record: { question: q, answer: item.referenceAnswer! }, number: q.number || '1', kindLabel: '', explanation: item.note, position: item.source }] }); status.textContent = '已加入题库，请在课程面板选择此库。';
        }); }));
      details.append(note, tags, actions); card.append(title, meta, details); list.append(card);
    }
    if (!found.length) list.append(el('p', items.length ? '没有符合条件的收藏。' : '在题目旁点击“收藏”或“标记错题”，即可在这里管理。'));
    count.textContent = `${items.length}/500 条 · 第 ${page + 1}/${pages} 页`; previous.disabled = page === 0; next.disabled = page + 1 >= pages; remove.disabled = !selected.size;
  }
  const previous = button('上一页收藏', () => { page--; render(); }); const next = button('下一页收藏', () => { page++; render(); }); paging.append(previous, count, next);
  filter.oninput = kind.onchange = () => { page = 0; render(); };
  const changed = (m: { type?: string }, sender: chrome.runtime.MessageSender) => { if (sender.id === chrome.runtime.id && ['toolbox:saved:changed', 'toolbox:local-question-bank:changed'].includes(m.type ?? '')) void refresh().catch(e => { status.textContent = String(e); }); };
  chrome.runtime.onMessage.addListener(changed); toolbar.append(exportAll, exportNotes, remove); const restoreLabel = el('label', '恢复完整备份'); restoreLabel.append(file);
  body.append(help, filter, kind, toolbar, restoreLabel, preview, status, list, paging); root.append(heading, body);
  void refresh().catch(e => { status.textContent = e instanceof Error ? e.message : '读取失败。'; });
  return () => { disposed = true; epoch++; chrome.runtime.onMessage.removeListener(changed); root.replaceChildren(); };
}
