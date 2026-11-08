import { readApiSettings, saveApiSettings, testApiConnection } from './client';
import { apiOrigin, apiSettingsOrigins, emptyApiConfig, emptyApiSettings, normalizeApiConfig, normalizeApiEndpoint, validateApiSettings, rankedProfiles, MAX_API_PROFILES, type ApiConfig, type ApiSettings, type ApiProfile } from './types';
import { API_PRESETS, presetApiConfig } from './presets';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
};
const ordered = (settings: ApiSettings) => [...settings.profiles].sort((a, b) => a.priority - b.priority || settings.profiles.indexOf(a) - settings.profiles.indexOf(b));
function provider(config: ApiConfig) {
  let host = ''; try { host = new URL(config.endpoint).hostname; } catch { /* Empty custom draft. */ }
  if (host === 'api.deepseek.com') return { name: 'DeepSeek', host, mark: 'D', kind: 'deepseek' };
  if (host.endsWith('.xiaomimimo.com')) return { name: 'MiMo', host, mark: 'M', kind: 'mimo' };
  return { name: host || '自定义接口', host, mark: 'A', kind: 'custom' };
}

/** Only this trusted extension page renders or edits API credentials. */
export function mountApiSettings(root: HTMLElement): () => void {
  root.innerHTML = `<section class="card model-manager" aria-label="模型管理">
    <div class="model-heading"><div><h2>模型服务</h2><p>按列表顺序优先调用已启用的模型。</p></div><span class="model-count"></span></div>
    <div class="model-toolbar"><div class="model-presets"><button type="button" class="secondary" data-preset="deepseek-1017">＋ DeepSeek</button><button type="button" class="secondary" data-preset="mimo-flash">＋ MiMo</button><button type="button" class="secondary add-model">＋ 自定义模型</button></div><span class="field-help">最多 10 个模型</span></div>
    <div class="model-list" role="list" aria-label="已接入模型"></div>
    <p class="model-order field-help"></p>
    <div class="model-savebar"><div><p class="saved-status" role="status" aria-live="polite">正在读取模型…</p><button type="button" class="text-button model-undo" hidden>撤销移除</button></div><button type="button" class="primary save-api" disabled>保存列表更改</button></div>
    <div class="model-feedback"><p class="feedback" role="status" aria-live="polite" hidden></p><button class="secondary retry-button" type="button" hidden>重新读取设置</button></div>
  </section>
  <dialog class="model-editor" aria-labelledby="model-editor-title">
    <div class="model-editor-heading"><div><h2 id="model-editor-title">编辑模型</h2><p class="model-editor-subtitle"></p></div><button type="button" class="text-button close-model" aria-label="取消编辑">×</button></div>
    <form class="settings-form" autocomplete="off">
      <div class="model-picker"><div class="field"><label for="api-preset">快速配置</label><select id="api-preset"></select></div><button class="secondary apply-preset" type="button">应用到当前草稿</button></div>
      <p class="field-help preset-note"></p><a class="preset-docs" target="_blank" rel="noopener noreferrer">查看预设文档</a>
      <div class="model-meta"><div class="field"><label for="api-name">备注名称</label><input id="api-name" maxlength="80" required></div><div class="field"><label for="api-priority">优先级</label><input id="api-priority" type="number" min="1" max="999" step="1" required></div></div>
      <div class="field"><label for="api-endpoint">API 地址</label><input id="api-endpoint" type="url" inputmode="url" placeholder="https://服务商域名/v1" spellcheck="false" autocapitalize="none" maxlength="2048" aria-describedby="endpoint-preview endpoint-error" required><p class="field-help">可填写基础地址或完整 Chat Completions 地址。</p><p id="endpoint-preview" class="field-help endpoint-preview" hidden></p><p id="endpoint-error" class="field-error" hidden></p></div>
      <div class="field"><label for="api-key">API Key</label><div class="input-action"><input id="api-key" type="password" spellcheck="false" autocapitalize="none" autocomplete="off" maxlength="4096" required><button type="button" class="secondary reveal-key" aria-controls="api-key" aria-pressed="false">显示</button></div><p class="field-help">密钥仅保存在本机，列表中不显示。</p></div>
      <div class="field"><label for="api-model">模型 ID</label><input id="api-model" spellcheck="false" autocapitalize="none" placeholder="服务商提供的准确模型 ID" maxlength="200" required><p class="field-help">模型 ID 按填写内容原样发送。</p></div>
      <div class="model-capabilities"><label class="checkbox-row"><input id="api-enabled" type="checkbox"><span>启用此模型</span></label><label class="checkbox-row"><input id="api-images" type="checkbox"><span>支持图片输入</span></label><label class="checkbox-row"><input id="api-stream" type="checkbox"><span>流式响应</span></label></div>
      <details class="advanced-settings"><summary>调用与数据说明</summary><p class="field-help">数字越小越优先，相同时按列表顺序；图片题只使用支持图片的模型。每题独立请求，不附带历史题目；失败后暂停供你处理。</p><p class="field-help">只有服务商支持 image_url 时才开启图片输入。保存时申请所填接口域名的访问权限。</p></details>
      <div class="api-actions"><p class="editor-feedback field-help" role="status" aria-live="polite"></p><div class="button-row"><button type="submit" class="primary save-model">保存更改</button><button type="button" class="secondary test-api">测试此模型</button><button type="button" class="text-button cancel-model">取消编辑</button></div><p class="field-help">保存同步生效列表更改；连接测试发送一次短请求并计入用量。</p></div>
    </form>
  </dialog>`;
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const dialog = get<HTMLDialogElement>('dialog'); const form = get<HTMLFormElement>('form');
  const list = get<HTMLElement>('.model-list'); const status = get<HTMLElement>('.saved-status');
  const feedback = get<HTMLElement>('.feedback'); const editorFeedback = get<HTMLElement>('.editor-feedback');
  const name = get<HTMLInputElement>('#api-name'); const priority = get<HTMLInputElement>('#api-priority');
  const endpoint = get<HTMLInputElement>('#api-endpoint'); const key = get<HTMLInputElement>('#api-key');
  const model = get<HTMLInputElement>('#api-model'); const enabled = get<HTMLInputElement>('#api-enabled');
  const images = get<HTMLInputElement>('#api-images'); const stream = get<HTMLInputElement>('#api-stream');
  const preset = get<HTMLSelectElement>('#api-preset'); const save = get<HTMLButtonElement>('.save-api');
  const undo = get<HTMLButtonElement>('.model-undo'); const retry = get<HTMLButtonElement>('.retry-button');
  const reveal = get<HTMLButtonElement>('.reveal-key'); const test = get<HTMLButtonElement>('.test-api');
  let settings = emptyApiSettings(), stored = emptyApiSettings(); let selected = ''; let checkpoint: ApiProfile | undefined;
  let returnFocus: HTMLElement | undefined; let loaded = false, disposed = false; let busy: 'load' | 'save' | 'test' | undefined;
  const removed: Array<{ profile: ApiProfile; index: number }> = [];
  const connections = new Map<string, { kind: string; text: string }>();
  const changed = () => JSON.stringify(settings) !== JSON.stringify(stored);
  const current = () => settings.profiles.find(p => p.id === selected);
  const values = (): ApiConfig => normalizeApiConfig({ version: 1, endpoint: endpoint.value, apiKey: key.value, model: model.value, stream: stream.checked, supportsImages: images.checked });
  function capture() {
    const p = current(); if (!p || !dialog.open) return;
    const next = values(); if (JSON.stringify(p.config) !== JSON.stringify(next)) connections.delete(p.id);
    Object.assign(p, { name: name.value.trim(), priority: Number(priority.value), enabled: enabled.checked, config: next });
  }
  function safeText(value: string) {
    for (const secret of [key.value, ...settings.profiles.map(p => p.config.apiKey), ...stored.profiles.map(p => p.config.apiKey)]) if (secret) value = value.split(secret).join('***');
    return value.slice(0, 500);
  }
  function tell(message: string, error = false) {
    if (disposed) return; feedback.textContent = safeText(message); feedback.dataset.kind = error ? 'error' : 'success'; feedback.hidden = false;
    editorFeedback.textContent = dialog.open ? safeText(message) : ''; editorFeedback.dataset.error = String(error);
  }
  function inspectEndpoint(report = false) {
    const preview = get<HTMLElement>('#endpoint-preview'), error = get<HTMLElement>('#endpoint-error');
    preview.hidden = true; error.hidden = true; endpoint.removeAttribute('aria-invalid');
    if (!endpoint.value && !report) return false;
    try { const value = normalizeApiEndpoint(endpoint.value); apiOrigin(value); preview.textContent = `实际请求地址：${value}`; preview.hidden = false; return true; }
    catch (e) { if (report) { error.textContent = e instanceof Error ? e.message : '请检查 API 地址。'; error.hidden = false; endpoint.setAttribute('aria-invalid', 'true'); } return false; }
  }
  function apply(profile: ApiProfile) {
    name.value = profile.name; priority.value = String(profile.priority); enabled.checked = profile.enabled;
    endpoint.value = profile.config.endpoint; key.value = profile.config.apiKey; model.value = profile.config.model;
    images.checked = profile.config.supportsImages === true; stream.checked = profile.config.stream;
    key.type = 'password'; reveal.textContent = '显示'; reveal.setAttribute('aria-pressed', 'false');
    get<HTMLElement>('#model-editor-title').textContent = checkpoint ? '编辑模型' : '添加模型';
    get<HTMLElement>('.model-editor-subtitle').textContent = provider(profile.config).name;
    editorFeedback.textContent = ''; inspectEndpoint();
  }
  function endEditor(rollback: boolean) {
    const focusId = selected;
    if (rollback && selected) {
      if (checkpoint) { const index = settings.profiles.findIndex(p => p.id === selected); if (index >= 0) settings.profiles[index] = checkpoint; }
      else settings.profiles = settings.profiles.filter(p => p.id !== selected);
    }
    dialog.close(); selected = ''; checkpoint = undefined; key.value = ''; key.type = 'password'; render();
    const target = returnFocus?.isConnected ? returnFocus : list.querySelector<HTMLButtonElement>(`[data-profile="${focusId}"] .model-name`) ?? get<HTMLButtonElement>('.add-model'); target.focus();
  }
  function edit(profile: ApiProfile, trigger: HTMLElement, existing = true) {
    if (busy || disposed) return; returnFocus = trigger; selected = profile.id; checkpoint = existing ? structuredClone(profile) : undefined;
    apply(profile); dialog.showModal(); render(); name.focus();
  }
  function add(presetId: string | undefined, trigger: HTMLElement) {
    if (busy || !loaded || settings.profiles.length >= MAX_API_PROFILES) return;
    const chosen = API_PRESETS.find(p => p.id === presetId);
    const profile: ApiProfile = { id: crypto.randomUUID(), name: chosen?.name ?? `模型 ${settings.profiles.length + 1}`, priority: Math.min(999, Math.max(0, ...settings.profiles.map(p => p.priority)) + 1), enabled: true, config: presetId ? presetApiConfig(presetId) : emptyApiConfig() };
    settings.profiles.push(profile); edit(profile, trigger, false); if (chosen) { preset.value = chosen.id; inspectPreset(); key.focus(); }
  }
  function move(id: string, offset: number) {
    const rows = ordered(settings); const from = rows.findIndex(p => p.id === id); const to = from + offset;
    if (busy || to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to], rows[from]]; rows.forEach((p, i) => { p.priority = i + 1; }); settings.profiles = rows;
    render(); list.querySelector<HTMLButtonElement>(`[data-profile="${id}"] [data-move="${offset}"]`)?.focus();
  }
  function renderList() {
    const rows = ordered(settings); const first = rankedProfiles(settings)[0]?.id; list.replaceChildren();
    if (!rows.length) { const empty = node('div', '', 'model-empty'); empty.append(node('strong', loaded ? '接入你的第一个模型' : '正在读取模型…'), node('p', '选择 DeepSeek、MiMo，或添加支持 Chat Completions 的自定义接口。')); list.append(empty); }
    for (const [index, p] of rows.entries()) {
      const row = node('article', '', 'model-row'); row.dataset.profile = p.id; row.setAttribute('role', 'listitem'); row.dataset.enabled = String(p.enabled);
      const toggleLabel = node('label', '', 'switch model-enable'); const toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = p.enabled; toggle.disabled = Boolean(busy); toggle.setAttribute('aria-label', `启用 ${p.name || '未命名模型'}`);
      const track = node('span', '', 'switch-track'); track.setAttribute('aria-hidden', 'true'); toggleLabel.append(toggle, track);
      toggle.addEventListener('change', () => { if (busy) return; p.enabled = toggle.checked; render(); list.querySelector<HTMLInputElement>(`[data-profile="${p.id}"] input`)?.focus(); });
      const rank = node('span', String(index + 1), 'model-rank'); rank.title = `优先级 ${p.priority}`;
      const info = provider(p.config); const mark = node('span', info.mark, 'model-provider-mark'); mark.dataset.provider = info.kind; mark.setAttribute('aria-hidden', 'true');
      const identity = node('div', '', 'model-identity'); const heading = node('div', '', 'model-identity-title'); const editButton = node('button', p.name || '未命名模型', 'model-name'); editButton.type = 'button'; editButton.disabled = Boolean(busy); editButton.title = '编辑模型'; editButton.setAttribute('aria-label', `编辑 ${p.name || '未命名模型'}`); editButton.onclick = () => edit(p, editButton);
      heading.append(editButton); if (p.enabled && p.id === first) heading.append(node('span', '优先调用', 'model-tag first'));
      identity.append(heading, node('p', `${p.config.model || '待填写模型 ID'} · ${info.name === info.host ? info.host : info.name + (info.host ? ` / ${info.host}` : '')}`, 'model-address'));
      const tags = node('div', '', 'model-tags'); tags.append(node('span', p.config.supportsImages ? '文字 + 图片' : '仅文字', 'model-tag'), node('span', p.config.stream ? '流式' : '非流式', 'model-tag'));
      const savedProfile = stored.profiles.find(s => s.id === p.id); const draft = JSON.stringify(savedProfile) !== JSON.stringify(p);
      const connection = connections.get(p.id); const state = node('span', draft ? '待保存' : !p.enabled ? '已停用' : connection?.text ?? '已配置', 'model-state'); state.dataset.kind = draft ? 'draft' : connection?.kind ?? 'saved';
      const actions = node('div', '', 'model-row-actions');
      const action = (label: string, title: string, run: (button: HTMLButtonElement) => void, disabled = false) => { const b = node('button', label, 'model-row-action'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', `${title} ${p.name}`); b.disabled = disabled || Boolean(busy); b.onclick = () => run(b); actions.append(b); return b; };
      action('编辑', '配置', b => edit(p, b)); action(busy === 'test' && selected === p.id ? '连接中…' : '测试', '测试', () => { void testProfile(p.id); }, changed());
      action('↑', '上移', () => move(p.id, -1), index === 0).dataset.move = '-1'; action('↓', '下移', () => move(p.id, 1), index === rows.length - 1).dataset.move = '1';
      action('移除', '移除', () => { const at = settings.profiles.indexOf(p); removed.push({ profile: structuredClone(p), index: at }); settings.profiles.splice(at, 1); tell(`已移除“${p.name}”，保存列表后生效。`); render(); });
      row.append(toggleLabel, rank, mark, identity, tags, state, actions); list.append(row);
    }
  }
  function render() {
    if (disposed) return;
    const dirty = changed(); renderList();
    root.dataset.dirty = String(dirty); get<HTMLElement>('.model-count').textContent = `${settings.profiles.length} 个模型 / ${settings.profiles.filter(p => p.enabled).length} 个启用`;
    get<HTMLElement>('.model-order').textContent = `调用顺序：${rankedProfiles(settings).map(p => p.name || '未命名').join(' → ') || '全部停用'}。图片题按能力筛选；排序和启停保存后生效。`;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-preset], .add-model')) b.disabled = !loaded || Boolean(busy) || settings.profiles.length >= MAX_API_PROFILES;
    for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) input.disabled = Boolean(busy) || !loaded;
    get<HTMLButtonElement>('.close-model').disabled = Boolean(busy);
    test.disabled = Boolean(busy) || dirty || !stored.profiles.some(p => p.id === selected);
    save.disabled = !loaded || Boolean(busy) || !dirty; save.textContent = busy === 'save' ? '正在保存…' : '保存列表更改';
    get<HTMLButtonElement>('.save-model').textContent = busy === 'save' ? '正在保存…' : '保存更改'; test.textContent = busy === 'test' ? '正在连接…' : '测试此模型';
    undo.hidden = !removed.length; undo.disabled = Boolean(busy); retry.disabled = Boolean(busy);
    status.textContent = busy === 'load' ? '正在读取模型…' : !loaded ? '模型读取失败，请重新读取。' : dirty ? '有未保存更改，保存后生效。' : settings.profiles.length ? '模型列表已保存' : '尚未接入模型';
    status.dataset.dirty = String(dirty); root.setAttribute('aria-busy', String(Boolean(busy)));
  }
  async function saveSettings() {
    if (busy || !loaded || disposed) return; capture();
    const focusId = selected; const wasEditing = dialog.open;
    if (dialog.open && (!form.reportValidity() || !inspectEndpoint(true))) return;
    const next = structuredClone(settings); let grant: Promise<boolean>;
    try { validateApiSettings(next); const origins = apiSettingsOrigins(next); grant = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true); }
    catch (e) { tell(e instanceof Error ? e.message : '请检查模型配置。', true); return; }
    busy = 'save'; render();
    try {
      if (!await grant) { tell('接口域名权限未授予，原配置保留。', true); return; } if (disposed) return;
      await saveApiSettings(next); if (disposed) return; stored = structuredClone(next); settings = structuredClone(next); removed.length = 0;
      if (dialog.open) endEditor(false);
      tell('模型列表已保存，优先级与启停设置已生效。'); root.dispatchEvent(new CustomEvent('api-models-saved', { bubbles: true }));
    } catch (e) { tell(e instanceof Error ? e.message : '保存失败，原配置保留。', true); }
    finally { busy = undefined; render(); if (wasEditing && !dialog.open && !disposed) list.querySelector<HTMLButtonElement>(`[data-profile="${focusId}"] .model-name`)?.focus(); }
  }
  async function testProfile(id: string) {
    if (busy || changed() || disposed || !stored.profiles.some(p => p.id === id)) return;
    busy = 'test'; const before = selected; if (!dialog.open) selected = id; render(); tell('正在测试连接…');
    try { const result = await testApiConnection(id); if (disposed) return; connections.set(id, { kind: 'success', text: `连接正常 · ${Math.round(result.latencyMs)} ms` }); tell(`${result.message}（${Math.round(result.latencyMs)} ms）`); }
    catch (e) { if (!disposed) { connections.set(id, { kind: 'error', text: '连接失败' }); tell(e instanceof Error ? e.message : '连接失败，请核对模型配置。', true); } }
    finally { busy = undefined; selected = before; render(); if (!disposed) root.dispatchEvent(new CustomEvent('api-usage-updated', { bubbles: true })); }
  }
  async function load() {
    if (busy || disposed) return; busy = 'load'; render();
    try { const value = await readApiSettings(); if (disposed) return; stored = structuredClone(value); settings = structuredClone(value); loaded = true; retry.hidden = true; feedback.hidden = true; removed.length = 0; }
    catch { tell('模型读取失败，已有配置未被修改。', true); retry.hidden = false; }
    finally { busy = undefined; render(); }
  }
  for (const item of API_PRESETS) { const option = node('option', item.name); option.value = item.id; preset.append(option); }
  function inspectPreset() { const p = API_PRESETS.find(p => p.id === preset.value)!; get<HTMLElement>('.preset-note').textContent = p.note; get<HTMLAnchorElement>('.preset-docs').href = p.docs; }
  inspectPreset(); preset.onchange = inspectPreset;
  get<HTMLButtonElement>('.apply-preset').onclick = () => {
    if (busy || !current()) return;
    // Applying a preset never moves another model's key to a new endpoint.
    const p = API_PRESETS.find(p => p.id === preset.value)!; name.value = p.name; endpoint.value = p.endpoint; model.value = p.model; images.checked = p.images; key.value = ''; key.type = 'password'; reveal.textContent = '显示'; reveal.setAttribute('aria-pressed', 'false');
    capture(); inspectEndpoint(); render(); tell('已应用预设，请填写对应 Key。'); key.focus();
  };
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-preset]')) b.onclick = () => add(b.dataset.preset, b);
  const addButton = get<HTMLButtonElement>('.add-model'); addButton.onclick = () => add(undefined, addButton);
  save.onclick = () => { void saveSettings(); }; form.onsubmit = event => { event.preventDefault(); void saveSettings(); };
  test.onclick = () => { void testProfile(selected); };
  const cancel = () => { if (!busy) endEditor(true); };
  get<HTMLButtonElement>('.cancel-model').onclick = cancel; get<HTMLButtonElement>('.close-model').onclick = cancel;
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
  form.addEventListener('input', event => { if (event.target === preset) return; capture(); inspectEndpoint(); editorFeedback.textContent = ''; render(); });
  endpoint.addEventListener('blur', () => { if (inspectEndpoint(true)) { endpoint.value = normalizeApiEndpoint(endpoint.value); capture(); render(); } });
  reveal.onclick = () => { const visible = key.type === 'password'; key.type = visible ? 'text' : 'password'; reveal.textContent = visible ? '隐藏' : '显示'; reveal.setAttribute('aria-pressed', String(visible)); };
  undo.onclick = () => { if (busy) return; const item = removed.pop(); if (!item) return; settings.profiles.splice(Math.min(item.index, settings.profiles.length), 0, item.profile); render(); tell('已撤销移除，保存列表后生效。'); };
  retry.onclick = () => { void load(); }; void load();
  return () => { disposed = true; if (dialog.open) dialog.close(); key.value = ''; settings = emptyApiSettings(); stored = emptyApiSettings(); checkpoint = undefined; removed.length = 0; root.replaceChildren(); };
}
