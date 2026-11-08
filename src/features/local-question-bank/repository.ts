import { sanitizeBankEntry } from '../answer-exchange/protocol';
import type { BankEntry } from '../answer-exchange/types';
import type { QuestionSnapshot } from '../question-answer/types';
import { localBankEntryIdentity, localQuestionContentKey, matchLocalBank } from './matching';
import { LOCAL_QUESTION_BANK_BYTE_LIMIT, LOCAL_QUESTION_BANK_LIMIT } from './types';
import { defaultLocalPreferences, type DraftEntry, type LibraryInfo, type LibraryInput, type LibraryMatch,
  type LibraryState, type LocalAnswerProof, type LocalBankPreferences, type StoredEntry, type EntryRevision } from './library-types';
import { cleanSavedInput, savedQuestionId, SAVED_BYTES, SAVED_LIMIT, type SavedQuestion } from '../saved-questions/types';

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error('题库数据库读取失败。'));
});
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('题库操作未完成，数据没有提交。'));
});
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error('题库名称、说明或来源字段不符合长度要求。');
  return value;
}
export function cleanDraftEntries(value: unknown): DraftEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > LOCAL_QUESTION_BANK_LIMIT) throw new Error(`每次需要 1 至 ${LOCAL_QUESTION_BANK_LIMIT} 条完整题目。`);
  const entries = value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('题库条目结构无效。');
    const entry = item as DraftEntry;
    return { record: sanitizeBankEntry(entry.record, index), number: text(entry.number, 100, true),
      kindLabel: text(entry.kindLabel, 30), explanation: text(entry.explanation, 128_000), position: text(entry.position, 200) };
  });
  if (new TextEncoder().encode(JSON.stringify(entries)).byteLength > LOCAL_QUESTION_BANK_BYTE_LIMIT) throw new Error('题库内容超过 6 MB，请拆分整理。');
  return entries;
}
export function createLocalBankRepository(factory: IDBFactory = indexedDB, name = 'toolbox-question-libraries-v1') {
  let opening: Promise<IDBDatabase> | undefined;
  const db = () => opening ??= new Promise((resolve, reject) => {
    const req = factory.open(name, 2);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('libraries')) database.createObjectStore('libraries', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('entries')) {
        const entries = database.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('libraryId', 'libraryId'); entries.createIndex('contentKey', 'contentKey');
      }
      if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta');
      if (!database.objectStoreNames.contains('revisions')) { const store = database.createObjectStore('revisions', { keyPath: 'id' }); store.createIndex('entryId', 'entryId'); }
      if (!database.objectStoreNames.contains('saved')) database.createObjectStore('saved', { keyPath: 'id' });
    };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = undefined; }; resolve(req.result); };
    req.onerror = () => { opening = undefined; reject(new Error('无法打开本地题库数据库。')); };
    req.onblocked = () => { reject(new Error('题库数据库正被旧设置页占用，请关闭旧设置页后重试。')); };
  });
  async function transact<T>(mode: IDBTransactionMode, operation: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const database = await db(); const tx = database.transaction(['libraries', 'entries', 'meta', 'revisions', 'saved'], mode);
    const completion = finished(tx);
    try { const result = await operation(tx); await completion; return result; }
    catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await completion.catch(() => undefined); throw error; }
  }
  const revision = async (tx: IDBTransaction) => Number(await request(tx.objectStore('meta').get('revision'))) || 0;
  const bump = async (tx: IDBTransaction) => { const value = await revision(tx) + 1; tx.objectStore('meta').put(value, 'revision'); return value; };
  const libraries = async (tx: IDBTransaction) => await request(tx.objectStore('libraries').getAll()) as LibraryInfo[];
  async function edit(tx: IDBTransaction, id: string, expected: number, draft: DraftEntry): Promise<StoredEntry> {
    const clean = cleanDraftEntries([draft])[0];
    const current = await request(tx.objectStore('entries').get(id)) as StoredEntry | undefined;
    if (!current) throw new Error('题目已删除，请刷新列表。');
    if (!Number.isSafeInteger(expected) || expected !== (current.version ?? 1)) throw new Error('这道题已被其他窗口修改，请保留草稿并重新打开最新题目。');
    const all = await request(tx.objectStore('entries').getAll()) as StoredEntry[];
    const contentKey = localQuestionContentKey(clean.record.question);
    if (!contentKey) throw new Error('修改后的题目不完整，未保存。');
    const updatedAt = new Date().toISOString();
    const updated: StoredEntry = { ...clean, id, libraryId: current.libraryId, contentKey,
      answerKey: localBankEntryIdentity(clean.record), version: expected + 1, updatedAt };
    if (new TextEncoder().encode(JSON.stringify(all.map(e => e.id === id ? updated : e))).byteLength > LOCAL_QUESTION_BANK_BYTE_LIMIT) throw new Error('题库修改超过 6 MB，未保存。');
    const history = await request(tx.objectStore('revisions').getAll()) as EntryRevision[];
    const previous: DraftEntry = { record: current.record, number: current.number, kindLabel: current.kindLabel, explanation: current.explanation, position: current.position };
    const log: EntryRevision = { id: crypto.randomUUID(), entryId: id, version: expected, previous, changedAt: updatedAt };
    const logs = [...history, log]; const own = logs.filter(e => e.entryId === id);
    const expired = new Set(own.slice(0, Math.max(0, own.length - 20)).map(e => e.id));
    const retained = logs.filter(e => !expired.has(e.id));
    while (retained.length > 2000 || new TextEncoder().encode(JSON.stringify(retained)).byteLength > 2 * 1024 * 1024) {
      if (retained.length === 1) throw new Error('本题修订记录过大，未保存。');
      expired.add(retained.shift()!.id);
    }
    for (const old of expired) tx.objectStore('revisions').delete(old);
    tx.objectStore('revisions').put(log); tx.objectStore('entries').put(updated);
    const lib = await request(tx.objectStore('libraries').get(current.libraryId)) as LibraryInfo;
    const groups = new Map<string, Set<string>>();
    for (const item of all.map(e => e.id === id ? updated : e).filter(e => e.libraryId === lib.id)) {
      const group = groups.get(item.contentKey) ?? new Set(); group.add(item.answerKey); groups.set(item.contentKey, group);
    }
    lib.conflicts = [...groups.values()].filter(g => g.size > 1).length; lib.fileHash = '';
    tx.objectStore('libraries').put(lib); await bump(tx); return updated;
  }
  async function putLibrary(tx: IDBTransaction, input: LibraryInput, id: string = crypto.randomUUID()): Promise<LibraryInfo> {
    const clean = cleanDraftEntries(input.items); const unique = new Map<string, DraftEntry>();
    for (const entry of clean) unique.set(localBankEntryIdentity(entry.record), entry);
    const items = [...unique.values()];
    const all = await request(tx.objectStore('entries').getAll()) as StoredEntry[];
    if (all.length + items.length > LOCAL_QUESTION_BANK_LIMIT) throw new Error(`本地题库总计最多 ${LOCAL_QUESTION_BANK_LIMIT} 题，请先删除不用的题库。`);
    const groups = new Map<string, Set<string>>();
    const prepared: StoredEntry[] = [];
    for (const item of items) {
      const contentKey = localQuestionContentKey(item.record.question);
      if (!contentKey) throw new Error('题库包含不能完整匹配的题目。');
      const answerKey = localBankEntryIdentity(item.record);
      const group = groups.get(contentKey) ?? new Set(); group.add(answerKey); groups.set(contentKey, group);
      const entry: StoredEntry = { ...item, id: crypto.randomUUID(), libraryId: id, contentKey, answerKey };
      prepared.push(entry);
    }
    const info: LibraryInfo = { id, name: text(input.name, 100, true).trim(), course: text(input.course, 200).trim(),
      filename: text(input.filename, 255), fileHash: text(input.fileHash, 100), format: text(input.format, 30),
      createdAt: new Date().toISOString(), enabled: true, count: items.length,
      conflicts: [...groups.values()].filter(group => group.size > 1).length };
    if (new TextEncoder().encode(JSON.stringify([...all, ...prepared])).byteLength > LOCAL_QUESTION_BANK_BYTE_LIMIT) throw new Error('本地题库总内容超过 6 MB，请先整理旧题库。');
    for (const entry of prepared) tx.objectStore('entries').put(entry);
    tx.objectStore('libraries').put(info); await bump(tx); return info;
  }
  return {
    async editEntry(id: string, expected: number, draft: DraftEntry) { return transact('readwrite', tx => edit(tx, id, expected, draft)); },
    async entryHistory(id: string): Promise<EntryRevision[]> { return transact('readonly', async tx => (await request(tx.objectStore('revisions').index('entryId').getAll(id)) as EntryRevision[]).sort((a, b) => b.version - a.version)); },
    async undoEntry(id: string, expected: number) {
      return transact('readwrite', async tx => {
        const logs = await request(tx.objectStore('revisions').index('entryId').getAll(id)) as EntryRevision[];
        const last = logs.sort((a, b) => b.version - a.version)[0];
        if (!last) throw new Error('没有可撤销的修改。');
        return edit(tx, id, expected, last.previous);
      });
    },
    async saved(): Promise<SavedQuestion[]> { return transact('readonly', async tx => (await request(tx.objectStore('saved').getAll()) as SavedQuestion[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); },
    async saveQuestion(value: unknown, expected?: number): Promise<SavedQuestion> {
      const clean = cleanSavedInput(value); const id = await savedQuestionId(clean.question, clean.course);
      return transact('readwrite', async tx => {
        const old = await request(tx.objectStore('saved').get(id)) as SavedQuestion | undefined;
        if (expected !== undefined && expected !== old?.version) throw new Error('收藏已在其他窗口修改，请刷新后重试。');
        // A repeated quick-save must not overwrite notes or an existing wrong mark.
        if (old && expected === undefined) { if (clean.wrong && !old.wrong) { old.wrong = true; old.version++; old.updatedAt = new Date().toISOString(); tx.objectStore('saved').put(old); } return old; }
        const now = new Date().toISOString();
        const entry: SavedQuestion = { ...clean, id, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now,
          updatedAt: now, mastered: old?.mastered ?? false };
        const all = (await request(tx.objectStore('saved').getAll()) as SavedQuestion[]).filter(e => e.id !== id); all.push(entry);
        if (all.length > SAVED_LIMIT || new TextEncoder().encode(JSON.stringify(all)).byteLength > SAVED_BYTES) throw new Error('收藏已达到 500 条或 5 MB，请先导出并整理。');
        tx.objectStore('saved').put(entry); return entry;
      });
    },
    async markMastered(id: string, expected: number, mastered: boolean) {
      return transact('readwrite', async tx => {
        const old = await request(tx.objectStore('saved').get(id)) as SavedQuestion | undefined;
        if (!old || old.version !== expected || typeof mastered !== 'boolean') throw new Error('收藏已变化，请刷新重试。');
        old.mastered = mastered; old.version++; old.updatedAt = new Date().toISOString(); tx.objectStore('saved').put(old);
      });
    },
    async removeSaved(ids: string[]) { return transact('readwrite', async tx => { for (const id of ids) tx.objectStore('saved').delete(id); }); },
    async exportData() {
      return transact('readonly', async tx => ({ kind: 'toolbox-library-backup', version: 2,
        libraries: await libraries(tx), entries: await request(tx.objectStore('entries').getAll()) as StoredEntry[],
        revisions: await request(tx.objectStore('revisions').getAll()) as EntryRevision[], saved: await request(tx.objectStore('saved').getAll()) as SavedQuestion[] }));
    },
    async restoreData(value: unknown) {
      const v = value as { kind?: string; version?: number; libraries?: LibraryInfo[]; entries?: StoredEntry[]; revisions?: EntryRevision[]; saved?: SavedQuestion[] };
      if (!v || v.kind !== 'toolbox-library-backup' || v.version !== 2 || !Array.isArray(v.libraries) || v.libraries.length > 2000
        || !Array.isArray(v.entries) || v.entries.length > 2000 || !Array.isArray(v.saved) || v.saved.length > SAVED_LIMIT
        || !Array.isArray(v.revisions) || v.revisions.length > 2000) throw new Error('请使用本插件导出的完整题库与收藏备份。');
      const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
      const validTime = (time: unknown): time is string => typeof time === 'string' && time.length <= 40 && Number.isFinite(Date.parse(time));
      const validVersion = (version: unknown): version is number => typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 && version < Number.MAX_SAFE_INTEGER;
      const libs: LibraryInfo[] = v.libraries.map(lib => {
        if (!lib || !validId(lib.id) || !validTime(lib.createdAt) || typeof lib.enabled !== 'boolean') throw new Error('备份中的题库信息无效。');
        return { id: lib.id, name: text(lib.name, 100, true), course: text(lib.course, 200), filename: text(lib.filename, 255),
          fileHash: text(lib.fileHash, 100), format: text(lib.format, 30), createdAt: lib.createdAt, enabled: lib.enabled, count: 0, conflicts: 0 };
      });
      if (new Set(libs.map(l => l.id)).size !== libs.length) throw new Error('备份含重复题库编号。');
      const items: StoredEntry[] = v.entries.map(item => {
        if (!item || !validId(item.id) || !libs.some(l => l.id === item.libraryId) || (item.version !== undefined && !validVersion(item.version))) throw new Error('备份题目编号无效。');
        const clean = cleanDraftEntries([item])[0]; const key = localQuestionContentKey(clean.record.question);
        if (!key) throw new Error('备份题目不完整。');
        return { ...clean, id: item.id, libraryId: item.libraryId, contentKey: key, answerKey: localBankEntryIdentity(clean.record), version: item.version ?? 1 };
      });
      if (new Set(items.map(i => i.id)).size !== items.length || new TextEncoder().encode(JSON.stringify(items)).byteLength > LOCAL_QUESTION_BANK_BYTE_LIMIT) throw new Error('备份题目重复或超过容量。');
      const saved: SavedQuestion[] = await Promise.all(v.saved.map(async item => {
        const clean = cleanSavedInput(item); const id = await savedQuestionId(clean.question, clean.course);
        if (item.id !== id || !validVersion(item.version) || !validTime(item.createdAt) || !validTime(item.updatedAt) || typeof item.mastered !== 'boolean') throw new Error('备份收藏无效。');
        return { ...clean, id, version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt, mastered: item.mastered };
      }));
      if (new Set(saved.map(s => s.id)).size !== saved.length || new TextEncoder().encode(JSON.stringify(saved)).byteLength > SAVED_BYTES) throw new Error('备份收藏重复或超过容量。');
      const logs: EntryRevision[] = v.revisions.map(log => {
        if (!log || !validId(log.id) || !items.some(i => i.id === log.entryId) || !validVersion(log.version) || !validTime(log.changedAt)) throw new Error('备份修订记录无效。');
        return { id: log.id, entryId: log.entryId, version: log.version, changedAt: log.changedAt, previous: cleanDraftEntries([log.previous])[0] };
      });
      if (new Set(logs.map(l => l.id)).size !== logs.length || new TextEncoder().encode(JSON.stringify(logs)).byteLength > 2 * 1024 * 1024
        || items.some(i => logs.filter(l => l.entryId === i.id).length > 20)) throw new Error('备份修订记录超过容量。');
      for (const lib of libs) {
        const own = items.filter(i => i.libraryId === lib.id); const groups = new Map<string, Set<string>>();
        for (const item of own) { const group = groups.get(item.contentKey) ?? new Set(); group.add(item.answerKey); groups.set(item.contentKey, group); }
        lib.count = own.length; lib.conflicts = [...groups.values()].filter(g => g.size > 1).length;
      }
      await transact('readwrite', async tx => {
        const oldEntries = await request(tx.objectStore('entries').getAll()) as StoredEntry[];
        const oldSaved = await request(tx.objectStore('saved').getAll()) as SavedQuestion[];
        for (const item of items) item.version = Math.max(item.version ?? 1, oldEntries.find(e => e.id === item.id)?.version ?? 1) + 1;
        for (const item of saved) item.version = Math.max(item.version, oldSaved.find(e => e.id === item.id)?.version ?? 0) + 1;
        for (const key of ['libraries', 'entries', 'revisions', 'saved']) tx.objectStore(key).clear();
        for (const lib of libs) tx.objectStore('libraries').put(lib);
        for (const item of items) tx.objectStore('entries').put(item);
        for (const log of logs) tx.objectStore('revisions').put(log);
        for (const item of saved) tx.objectStore('saved').put(item);
        await bump(tx);
      });
    },
    async migrate(legacy: BankEntry[]) {
      await transact('readwrite', async tx => {
        if (await request(tx.objectStore('meta').get('legacyMigrated'))) return;
        if (legacy.length) await putLibrary(tx, { name: '旧版导入题库', course: '', filename: '', fileHash: '', format: 'legacy-json',
          items: legacy.map((record, i) => ({ record, number: String(i + 1), kindLabel: '', explanation: '', position: '旧版本地题库' })) }, 'legacy-bank');
        tx.objectStore('meta').put(true, 'legacyMigrated');
      });
    },
    async state(context = 'manager'): Promise<LibraryState> {
      return transact('readonly', async tx => {
        const list = await libraries(tx);
        const prefs = await request(tx.objectStore('meta').get(`preferences:${context}`)) as LocalBankPreferences | undefined;
        return { revision: await revision(tx), libraries: list, total: list.reduce((sum, lib) => sum + lib.count, 0),
          preferences: prefs ?? defaultLocalPreferences() };
      });
    },
    async entries(id?: string): Promise<StoredEntry[]> {
      return transact('readonly', async tx => await request(id ? tx.objectStore('entries').index('libraryId').getAll(id) : tx.objectStore('entries').getAll()) as StoredEntry[]);
    },
    async importLibrary(input: LibraryInput): Promise<{ library: LibraryInfo; duplicate: boolean }> {
      return transact('readwrite', async tx => {
        const list = await libraries(tx);
        const old = input.fileHash && list.find(lib => lib.fileHash === input.fileHash);
        if (old) return { library: old, duplicate: true };
        return { library: await putLibrary(tx, input), duplicate: false };
      });
    },
    async update(id: string, patch: { name?: string; enabled?: boolean }) {
      await transact('readwrite', async tx => {
        const lib = await request(tx.objectStore('libraries').get(id)) as LibraryInfo | undefined;
        if (!lib) throw new Error('题库已不存在，请刷新列表。');
        if (patch.name !== undefined) lib.name = text(patch.name, 100, true).trim();
        if (patch.enabled !== undefined) {
          if (typeof patch.enabled !== 'boolean') throw new Error('启用状态无效。'); lib.enabled = patch.enabled;
        }
        tx.objectStore('libraries').put(lib); await bump(tx);
      });
    },
    async remove(id?: string, entryIds?: string[]) {
      await transact('readwrite', async tx => {
        if (id === undefined) { tx.objectStore('entries').clear(); tx.objectStore('libraries').clear(); tx.objectStore('revisions').clear(); }
        else {
          const lib = await request(tx.objectStore('libraries').get(id)) as LibraryInfo | undefined;
          if (!lib) throw new Error('题库已不存在，请刷新列表。');
          const all = await request(tx.objectStore('entries').index('libraryId').getAll(id)) as StoredEntry[];
          const selected = entryIds ? new Set(entryIds) : undefined;
          const remaining = all.filter(entry => selected && !selected.has(entry.id));
          for (const item of all) if (!selected || selected.has(item.id)) {
            tx.objectStore('entries').delete(item.id);
            const logs = await request(tx.objectStore('revisions').index('entryId').getAll(item.id)) as EntryRevision[];
            for (const log of logs) tx.objectStore('revisions').delete(log.id);
          }
          if (!selected) tx.objectStore('libraries').delete(id);
          else {
            const groups = new Map<string, Set<string>>();
            for (const item of remaining) { const values = groups.get(item.contentKey) ?? new Set(); values.add(item.answerKey); groups.set(item.contentKey, values); }
            lib.count = remaining.length; lib.conflicts = [...groups.values()].filter(values => values.size > 1).length;
            // A modified library can be imported again from the original file.
            lib.fileHash = ''; tx.objectStore('libraries').put(lib);
          }
        }
        await bump(tx);
      });
    },
    async preferences(context: string, prefs: LocalBankPreferences) {
      if (!prefs || typeof prefs.enabled !== 'boolean' || typeof prefs.onlineFallback !== 'boolean' || !Array.isArray(prefs.libraryIds)
        || prefs.libraryIds.length > 2000 || !prefs.libraryIds.every(id => typeof id === 'string' && id.length <= 100)) throw new Error('本地题库选项无效。');
      await transact('readwrite', async tx => {
        const ids = new Set((await libraries(tx)).map(lib => lib.id));
        tx.objectStore('meta').put({ enabled: prefs.enabled, onlineFallback: prefs.onlineFallback, libraryIds: [...new Set(prefs.libraryIds)].filter(id => ids.has(id)) }, `preferences:${text(context, 150, true)}`);
        await bump(tx);
      });
    },
    async match(question: QuestionSnapshot, libraryIds: string[]): Promise<LibraryMatch> {
      return transact('readonly', async tx => {
        const rev = await revision(tx); const key = localQuestionContentKey(question);
        if (!key) return { status: 'missing', revision: rev, sources: [], message: '本地题库仅匹配完整纯文本题目，请核对缺字、图片或重复选项。' };
        const chosen = new Set(libraryIds);
        const list = (await libraries(tx)).filter(lib => lib.enabled && chosen.has(lib.id));
        const libMap = new Map(list.map(lib => [lib.id, lib]));
        const candidates = (await request(tx.objectStore('entries').index('contentKey').getAll(key)) as StoredEntry[]).filter(entry => libMap.has(entry.libraryId));
        const result = matchLocalBank(question, candidates.map(entry => entry.record));
        return { ...result, revision: rev, sources: candidates.map(entry => ({ libraryId: entry.libraryId, entryId: entry.id,
          name: libMap.get(entry.libraryId)!.name, number: entry.number, position: entry.position })) };
      });
    },
    async validate(proof: LocalAnswerProof) {
      if (!proof || !Number.isSafeInteger(proof.revision) || !Array.isArray(proof.entryIds) || !proof.entryIds.length || proof.entryIds.length > 2000
        || !Array.isArray(proof.libraryIds) || typeof proof.context !== 'string') return false;
      return transact('readonly', async tx => {
        if (await revision(tx) !== proof.revision) return false;
        const prefs = await request(tx.objectStore('meta').get(`preferences:${proof.context}`)) as LocalBankPreferences | undefined;
        if (!prefs?.enabled) return false;
        const list = await libraries(tx); const selected = new Set(prefs.libraryIds);
        for (const id of proof.libraryIds) if (!selected.has(id) || !list.some(lib => lib.id === id && lib.enabled)) return false;
        for (const id of proof.entryIds) {
          const entry = await request(tx.objectStore('entries').get(id)) as StoredEntry | undefined;
          if (!entry || !proof.libraryIds.includes(entry.libraryId)) return false;
        }
        return true;
      });
    },
    async close() { (await opening)?.close(); opening = undefined; },
  };
}
