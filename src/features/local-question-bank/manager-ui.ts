import { parseExchangePack } from '../answer-exchange/protocol';
import { formatApplicableAnswer } from '../question-answer/answer-format';
import { downloadResultsFile } from '../question-answer/export-ui';
import { readBankFile } from './file-client';
import { deleteLibrary, getLibraryEntries, getLibraryState, importLibrary, subscribeLibraries, updateLibrary } from './library-client';
import type { BankDraft, LibraryState } from './library-types';
import { cleanDraftEntries } from './repository';
import { draftFromBankEntries, parseBankTemplate, sampleBankTemplate, serializeBankTemplate } from './template';
import { bankTemplateExample } from './template-example';
import { openEntryEditor } from './editor-ui';
import { defaultImportOptions, type ImportOptions, type SourcePreview } from './document-types';
import { hasUnresolvedDocumentContent } from './document-review';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
const button = (text: string, action: () => void) => { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; };
function download(content: string, name: string, json = false) {
  // eslint-disable-next-line no-control-regex
  downloadResultsFile({ content, name: `${name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 80) || '题库'}.${json ? 'json' : 'txt'}`, mime: json ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8', count: 0 });
}

export function mountLocalBankManager(root: HTMLElement): () => void {
  root.classList.add('local-bank-manager');
  root.innerHTML = `<section class="settings-card library-import">
    <div class="section-heading"><div><h2>我的题库</h2><p>文件保存在本机。先预览、确认入库，再到答题设置选择适用题库。</p></div></div>
    <div class="library-body">
      <div class="library-toolbar">
        <label class="library-file-label">选择题库文件<input type="file" accept=".txt,.docx,.pdf,.json,.png,.jpg,.jpeg,.webp" aria-label="选择题库文件"></label>
        <label>TXT 编码<select aria-label="TXT 编码"><option value="utf-8">UTF-8（推荐）</option><option value="gb18030">GB18030 / GBK</option></select></label>
        <button type="button" data-action="template">下载模板</button><button type="button" data-action="cancel" hidden>取消读取</button>
      </div>
      <label class="library-mode">读取方式<select aria-label="读取方式"><option value="auto">结构提取 · DOCX / 文字 PDF</option><option value="ocr">本地 OCR · 扫描件 / 图片 / 混合 PDF</option><option value="strict">严格模板 · 原有单栏文档</option></select></label>
      <details class="library-read-settings"><summary>页码、分栏与截取设置</summary><div class="library-read-grid">
        <label>PDF 页码范围<input aria-label="PDF 页码范围" placeholder="留空为全部，如 1-5,8" maxlength="300"></label>
        <label>PDF 阅读顺序<select aria-label="PDF 阅读顺序"><option value="auto">自动判断分栏</option><option value="rows">按行 · 从上到下</option><option value="columns">先左栏后右栏</option><option value="columns-right">先右栏后左栏</option></select></label>
        <label>OCR 语言<select aria-label="OCR 语言"><option value="chi_sim+eng">简体中文 + English</option><option value="eng">English</option></select></label>
        <label>截取范围（百分比）<input aria-label="截取范围" placeholder="x,y,宽,高，如 0,8,100,84" maxlength="80"></label>
      </div><p class="field-help">页码和分栏用于 PDF；截取用于 PDF 与图片。OCR 最多每批 20 页/图片，文字 PDF 最多 200 页。OCR 语言包已内置，识别时无需联网。严格模板不使用这些设置。</p></details>
      <div class="library-toolbar"><button type="button" data-action="reread" disabled>重新读取</button><span class="library-read-hint field-help">修改读取设置后，点击重新读取。</span></div>
      <p class="field-help">支持 TXT、JSON、DOCX、PDF、PNG/JPG/WebP。TXT/JSON ≤5 MB，其余 ≤20 MB；旧 DOC 请另存为 DOCX。识别后仍须整理为固定模板，导入不启动答题。</p>
      <details class="library-format-help"><summary>模板格式与题型说明</summary><pre></pre><p>支持单选、多选、判断、填空和简答。多选写 A,C；判断写正确/错误；填空写空数并逐行编号答案。DOCX 支持基本自动编号、表格字段和上下标，复杂对象请对照原文件转写。</p></details>
      <p class="library-status" role="status" aria-live="polite"></p>
      <section class="library-preview" aria-label="题库导入预览" hidden>
        <div class="library-source-previews"></div><ul class="library-read-warnings"></ul>
        <label class="library-review" hidden><input type="checkbox">我已对照来源校对文字、题目、答案和阅读顺序</label>
        <label>题库名称<input class="library-name" maxlength="100"></label><label>课程标签（可选）<input class="library-course" maxlength="200"></label>
        <label>提取文本（可修正后重新校验）<textarea class="library-raw" spellcheck="false" rows="10"></textarea></label>
        <div class="library-toolbar"><button type="button" data-action="validate">重新校验</button><button type="button" data-action="commit" disabled>确认导入</button><button type="button" data-action="dismiss">取消导入</button></div>
        <p class="library-summary"></p><ul class="library-issues"></ul><ol class="library-preview-items"></ol>
      </section>
    </div></section>
    <section class="settings-card library-collection"><div class="section-heading"><h2>已导入题库</h2><span class="library-total"></span></div><div class="library-body"><label>搜索题库<input class="library-search" type="search" placeholder="库名、课程或文件名"></label><div class="library-list"></div><section class="library-detail" aria-label="题库详情" hidden></section></div></section>`;
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const file = query<HTMLInputElement>('input[type=file]'); const encoding = query<HTMLSelectElement>('[aria-label="TXT 编码"]');
  const mode = query<HTMLSelectElement>('[aria-label="读取方式"]'); const pages = query<HTMLInputElement>('[aria-label="PDF 页码范围"]');
  const layout = query<HTMLSelectElement>('[aria-label="PDF 阅读顺序"]'); const language = query<HTMLSelectElement>('[aria-label="OCR 语言"]'); const crop = query<HTMLInputElement>('[aria-label="截取范围"]');
  const reread = query<HTMLButtonElement>('[data-action=reread]'); const sourcePreviews = query<HTMLElement>('.library-source-previews');
  const warningList = query<HTMLElement>('.library-read-warnings'); const reviewLabel = query<HTMLLabelElement>('.library-review'); const review = query<HTMLInputElement>('.library-review input');
  const status = query<HTMLElement>('.library-status'); const preview = query<HTMLElement>('.library-preview');
  const name = query<HTMLInputElement>('.library-name'); const course = query<HTMLInputElement>('.library-course');
  const raw = query<HTMLTextAreaElement>('.library-raw'); const summary = query<HTMLElement>('.library-summary');
  const issues = query<HTMLElement>('.library-issues'); const previewItems = query<HTMLElement>('.library-preview-items');
  const list = query<HTMLElement>('.library-list'); const search = query<HTMLInputElement>('.library-search');
  const detail = query<HTMLElement>('.library-detail'); const commit = query<HTMLButtonElement>('[data-action=commit]');
  const cancel = query<HTMLButtonElement>('[data-action=cancel]');
  let state: LibraryState | undefined; let draft: BankDraft | undefined; let selectedFile: File | undefined;
  let positions: string[] | undefined; let extracting: AbortController | undefined; let disposed = false; let busy = false; let revision = 0;
  let selectedLibrary: string | undefined; let detailRevision = 0;
  let readWarnings: string[] = []; let settingsChanged = false;
  const importOptions = (): ImportOptions => ({ ...defaultImportOptions(), mode: mode.value as ImportOptions['mode'], pages: pages.value, layout: layout.value as ImportOptions['layout'], language: language.value as ImportOptions['language'], crop: crop.value });
  const canCommit = () => !!draft && !draft.issues.length && !!draft.items.length && !settingsChanged && (!readWarnings.length || review.checked) && !hasUnresolvedDocumentContent(raw.value);
  const tell = (message: string, error = false) => { status.textContent = message; status.dataset.error = String(error); };
  const controls = (disabled: boolean) => {
    busy = disabled; file.disabled = disabled; encoding.disabled = disabled; cancel.hidden = !extracting;
    for (const setting of [mode, pages, layout, language, crop]) setting.disabled = disabled;
    reread.disabled = disabled || !selectedFile || !file.files?.length;
    for (const control of preview.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input,textarea,button')) control.disabled = disabled;
    commit.disabled = disabled || !canCommit();
  };
  function showSources(previews: SourcePreview[]) {
    sourcePreviews.replaceChildren(...previews.map(item => {
      const panel = el('details'); panel.append(el('summary', `${item.label} · 查看来源`));
      if (item.image?.startsWith('data:image/')) { const image = el('img'); image.src = item.image; image.alt = item.label; image.loading = 'lazy'; panel.append(image); }
      panel.append(el('pre', item.text.slice(0, 50000)));
      if (item.text.length > 50000) panel.append(el('small', '来源结构预览只显示前 5 万字符，请结合原文件核对。'));
      return panel;
    }));
  }
  async function action(operation: () => Promise<void>) {
    if (busy || disposed) return; controls(true);
    try { await operation(); } catch (error) { tell(error instanceof Error ? error.message : '题库操作失败，请重试。', true); }
    finally { if (!disposed) controls(false); }
  }
  function parse(): void {
    try {
      if (selectedFile?.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(raw.value);
        if (data.kind === 'question-library' && data.version === 1) {
          draft = { name: String(data.name ?? ''), course: String(data.course ?? ''), declaredCount: data.items?.length,
            items: cleanDraftEntries(data.items), issues: [], duplicates: 0, conflicts: 0 };
        } else {
          const pack = parseExchangePack(raw.value);
          if (pack.mode !== 'bank') throw new Error('这是本次答题答案包，请在原页面导入；管理页只接收题库。');
          draft = draftFromBankEntries(pack.items, selectedFile.name.replace(/\.json$/i, ''));
        }
      } else draft = parseBankTemplate(raw.value, positions);
      name.value = draft.name; course.value = draft.course;
      summary.textContent = `识别 ${draft.declaredCount || 0} 题 · 可入库 ${draft.items.length} 题 · 重复 ${draft.duplicates} 题 · 冲突组 ${draft.conflicts} · 错误 ${draft.issues.length} 处。${draft.conflicts ? '冲突题保留，答题时必须核对。' : ''}`;
      issues.replaceChildren(...draft.issues.map(item => el('li', `${item.position}：${item.message}`)));
      previewItems.replaceChildren(...draft.items.slice(0, 30).map(item => {
        const row = el('li'); row.append(el('strong', `${item.number} · ${item.kindLabel || item.record.question.kind}`), el('p', item.record.question.stem),
          el('pre', formatApplicableAnswer(item.record.question, item.record.answer)), el('small', item.position)); return row;
      }));
      if (draft.items.length > 30) previewItems.append(el('li', '预览列出前 30 题；完整文本在上方，入库后可分页查看全部题目。'));
      const unresolved = hasUnresolvedDocumentContent(raw.value);
      if (unresolved) issues.append(el('li', '仍有图片、公式或对象待校对占位，请转写或删除不需要的内容后重新校验。'));
      tell(draft.issues.length ? '请修正格式错误后重新校验，尚未入库。' : unresolved ? '存在待校对对象，完成转写后才能入库。' : readWarnings.length && !review.checked ? '解析完成，请对照来源校对并勾选确认。' : '解析完成，请核对题目与答案后确认入库。', draft.issues.length > 0 || unresolved);
    } catch (error) { draft = undefined; issues.replaceChildren(); previewItems.replaceChildren(); summary.textContent = ''; tell(error instanceof Error ? error.message : '题库格式无法识别。', true); }
    controls(busy);
  }
  async function refresh() {
    const current = ++revision;
    try { const next = await getLibraryState(); if (disposed || current !== revision) return; state = next; render(); if (selectedLibrary) await showDetail(selectedLibrary); }
    catch (error) { if (!disposed) tell(error instanceof Error ? error.message : '题库列表读取失败。', true); }
  }
  function render() {
    if (!state) return;
    query<HTMLElement>('.library-total').textContent = `${state.libraries.length} 个题库 · ${state.total}/2000 题`;
    const term = search.value.trim().toLocaleLowerCase();
    const libraries = state.libraries.filter(lib => `${lib.name} ${lib.course} ${lib.filename}`.toLocaleLowerCase().includes(term));
    list.replaceChildren();
    if (!libraries.length) list.append(el('p', state.libraries.length ? '没有符合搜索条件的题库。' : '还没有题库，先下载模板或选择文件导入。', 'field-help'));
    for (const lib of libraries) {
      const card = el('article', '', 'library-card');
      const heading = el('div', '', 'library-card-heading'); const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = lib.enabled;
      enabled.setAttribute('aria-label', `启用题库 ${lib.name}`);
      enabled.addEventListener('change', () => { void action(async () => { await updateLibrary(lib.id, { enabled: enabled.checked }); await refresh(); tell('题库启用状态已更新，旧匹配结果已失效。'); }); });
      heading.append(el('h3', lib.name), enabled);
      const info = el('p', `${lib.count} 题${lib.conflicts ? ` · ${lib.conflicts} 组冲突` : ''} · ${lib.enabled ? '已启用' : '已停用'}${lib.course ? ` · ${lib.course}` : ''}`, 'field-help');
      const actions = el('div', '', 'library-toolbar');
      actions.append(button('查看题目', () => { void action(() => showDetail(lib.id)); }), button('模板 TXT', () => { void action(async () => download(serializeBankTemplate(await getLibraryEntries(lib.id), lib.name, lib.course), lib.name)); }),
        button('JSON 备份', () => { void action(async () => {
          const items = (await getLibraryEntries(lib.id)).map(({ record, number, kindLabel, explanation, position }) => ({ record, number, kindLabel, explanation, position }));
          download(JSON.stringify({ version: 1, kind: 'question-library', name: lib.name, course: lib.course, items }, null, 2), lib.name, true);
        }); }));
      const more = el('details'); more.append(el('summary', '更多'));
      const rename = el('input'); rename.value = lib.name; rename.maxLength = 100; rename.setAttribute('aria-label', `重命名 ${lib.name}`);
      const confirm = el('div', '', 'library-delete-confirm'); confirm.hidden = true;
      confirm.append(el('p', `删除“${lib.name}”及其中 ${lib.count} 题？删除后可通过原文件或 JSON 备份恢复。`),
        button('确认删除题库', () => { void action(async () => { await deleteLibrary(lib.id); if (selectedLibrary === lib.id) { selectedLibrary = undefined; detail.hidden = true; } await refresh(); tell('题库已删除，后续查询不会再使用它。'); }); }), button('取消', () => { confirm.hidden = true; }));
      more.append(rename, button('保存名称', () => { void action(async () => { await updateLibrary(lib.id, { name: rename.value }); await refresh(); tell('题库名称已保存。'); }); }), button('删除题库', () => { confirm.hidden = false; }), confirm);
      actions.append(more); card.append(heading, info, el('p', `${lib.filename || '本地导入'} · ${new Date(lib.createdAt).toLocaleString('zh-CN')}`, 'field-help'), actions); list.append(card);
    }
  }
  async function showDetail(id: string) {
    const current = ++detailRevision; const entries = await getLibraryEntries(id);
    if (disposed || current !== detailRevision) return;
    selectedLibrary = id; const lib = state?.libraries.find(item => item.id === id); if (!lib) { detail.hidden = true; return; }
    detail.hidden = false; detail.replaceChildren(el('h3', `${lib.name} · 题目详情`));
    const filter = el('input'); filter.type = 'search'; filter.placeholder = '搜索题干、答案或解析'; filter.setAttribute('aria-label', '搜索题目');
    const kind = el('select'); kind.setAttribute('aria-label', '筛选题型');
    for (const value of ['', ...new Set(entries.map(item => item.kindLabel || item.record.question.kind))]) { const option = el('option', value || '全部题型'); option.value = value; kind.append(option); }
    const onlyConflict = el('input'); onlyConflict.type = 'checkbox'; const conflictLabel = el('label', '只看冲突'); conflictLabel.prepend(onlyConflict);
    const selected = new Set<string>(); const rows = el('ol', '', 'library-entry-list'); const paging = el('div', '', 'library-toolbar'); const count = el('span'); let page = 0;
    const groups = new Map<string, Set<string>>(); entries.forEach(item => { const set = groups.get(item.contentKey) ?? new Set(); set.add(item.answerKey); groups.set(item.contentKey, set); });
    const confirmation = el('div', '', 'library-delete-confirm'); confirmation.hidden = true;
    const remove = button('删除勾选题目', () => {
      if (!selected.size || busy) return; confirmation.replaceChildren(el('p', `确认从“${lib.name}”删除 ${selected.size} 题？`),
        button('确认删除勾选题目', () => { void action(async () => { await deleteLibrary(id, [...selected]); await refresh(); tell('所选题目已删除，旧匹配结果已失效。'); }); }), button('取消', () => { confirmation.hidden = true; })); confirmation.hidden = false;
    }); remove.disabled = true;
    function renderEntries() {
      const term = filter.value.toLocaleLowerCase();
      const found = entries.filter(item => (!kind.value || (item.kindLabel || item.record.question.kind) === kind.value)
        && (!onlyConflict.checked || groups.get(item.contentKey)!.size > 1)
        && `${item.record.question.stem} ${formatApplicableAnswer(item.record.question, item.record.answer)} ${item.explanation}`.toLocaleLowerCase().includes(term));
      const pages = Math.max(1, Math.ceil(found.length / 20)); page = Math.min(page, pages - 1); rows.replaceChildren();
      for (const item of found.slice(page * 20, (page + 1) * 20)) {
        const row = el('li'); const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(item.id); check.setAttribute('aria-label', `选择题目 ${item.number}`);
        check.addEventListener('change', () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); remove.disabled = selected.size === 0; confirmation.hidden = true; });
        const heading = el('label', `${item.number} · ${item.kindLabel || item.record.question.kind}${groups.get(item.contentKey)!.size > 1 ? ' · 答案冲突，待核对' : ''}`); heading.prepend(check);
        row.append(heading, el('p', item.record.question.stem), ...item.record.question.options.map(option => el('p', `${option.label}. ${option.text}`, 'library-option')),
          el('pre', `题库答案：${formatApplicableAnswer(item.record.question, item.record.answer)}`), el('p', item.explanation), el('small', item.position));
        const edit = button('编辑题目', () => openEntryEditor(item, edit, refresh)); row.append(edit); rows.append(row);
      }
      count.textContent = `第 ${page + 1}/${pages} 页 · ${found.length} 题 · 已勾选 ${selected.size} 题`;
      previous.disabled = page === 0; next.disabled = page + 1 >= pages;
    }
    const previous = button('上一页', () => { page--; renderEntries(); }); const next = button('下一页', () => { page++; renderEntries(); });
    for (const control of [filter, kind, onlyConflict]) control.addEventListener(control === filter ? 'input' : 'change', () => { page = 0; renderEntries(); });
    paging.append(previous, count, next, remove, button('关闭详情', () => { selectedLibrary = undefined; detail.hidden = true; }));
    detail.append(filter, kind, conflictLabel, rows, paging, confirmation); renderEntries();
  }
  query<HTMLElement>('.library-format-help pre').textContent = sampleBankTemplate();
  query<HTMLButtonElement>('[data-action=template]').addEventListener('click', () => download(`\uFEFF${bankTemplateExample.replace(/\n/g, '\r\n')}`, '题库模板-CXQB-1'));
  query<HTMLButtonElement>('[data-action=validate]').addEventListener('click', () => { if (!busy) parse(); });
  query<HTMLButtonElement>('[data-action=dismiss]').addEventListener('click', () => { if (busy) return; draft = undefined; preview.hidden = true; file.value = ''; selectedFile = undefined; raw.value = ''; sourcePreviews.replaceChildren(); controls(false); tell('已取消导入，题库没有改动。'); });
  cancel.addEventListener('click', () => extracting?.abort());
  raw.addEventListener('input', () => { positions = undefined; draft = undefined; review.checked = false; commit.disabled = true; summary.textContent = '文本已修改，请重新校验并再次确认校对。'; });
  review.addEventListener('change', () => controls(busy));
  for (const setting of [mode, pages, layout, language, crop]) setting.addEventListener(setting instanceof HTMLInputElement ? 'input' : 'change', () => { if (!selectedFile) return; settingsChanged = true; review.checked = false; controls(busy); tell('读取设置已修改，请点击“重新读取”应用设置。'); });
  for (const input of [name, course]) input.addEventListener('input', () => { if (draft) { draft.name = name.value; draft.course = course.value; } });
  search.addEventListener('input', render);
  const load = async () => {
    if (busy || !file.files?.[0]) return;
    if (/\.(png|jpe?g|webp)$/i.test(file.files[0].name)) mode.value = 'ocr';
    selectedFile = file.files[0]; draft = undefined; preview.hidden = true; raw.value = ''; settingsChanged = false; review.checked = false; readWarnings = []; sourcePreviews.replaceChildren(); extracting = new AbortController(); controls(true); tell('正在本机读取文件…');
    try {
      const result = await readBankFile(selectedFile, extracting.signal, tell, encoding.value as 'utf-8' | 'gb18030', importOptions());
      if (disposed) return; raw.value = result.text; positions = result.locations; readWarnings = result.warnings ?? []; showSources(result.previews ?? []);
      warningList.replaceChildren(...readWarnings.map(message => el('li', message))); reviewLabel.hidden = !readWarnings.length; preview.hidden = false; parse();
    } catch (error) { if (!disposed) tell(error instanceof Error ? error.message : '读取失败。', true); }
    finally { extracting = undefined; if (!disposed) controls(false); }
  };
  file.addEventListener('change', () => { void load(); }); encoding.addEventListener('change', () => { void load(); });
  reread.addEventListener('click', () => { void load(); });
  commit.addEventListener('click', () => { void action(async () => {
    if (!canCommit() || !draft || !selectedFile) throw new Error('请先完成读取、格式校验和来源校对。');
    const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([name.value, course.value, draft.items])));
    const hash = Array.from(new Uint8Array(hashBytes), value => value.toString(16).padStart(2, '0')).join('');
    const result = await importLibrary({ name: name.value, course: course.value, items: draft.items, filename: selectedFile.name, fileHash: hash, format: selectedFile.name.split('.').at(-1) ?? 'txt' });
    draft = undefined; preview.hidden = true; file.value = ''; selectedFile = undefined; raw.value = ''; sourcePreviews.replaceChildren(); await refresh();
    tell(result.duplicate ? `该文件内容已存在于“${result.library.name}”，没有重复导入。` : `已导入“${result.library.name}” ${result.library.count} 题。请到当前课程答题设置中选择此库。`);
  }); });
  const unsubscribe = subscribeLibraries(() => { void refresh(); }); void refresh();
  return () => { disposed = true; revision++; detailRevision++; extracting?.abort(); unsubscribe(); root.replaceChildren(); };
}
