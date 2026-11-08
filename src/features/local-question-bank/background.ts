import { broadcastPublic, privateStorageReady, type BackgroundRoutes } from '../../core/background-context';
import { sanitizeBankEntry } from '../answer-exchange/protocol';
import type { BankEntry } from '../answer-exchange/types';
import type { QuestionSnapshot } from '../question-answer/types';
import { localBankEntryIdentity } from './matching';
import { createLocalBankRepository } from './repository';
import { bankCourseContext, type DraftEntry, type LibraryInput, type LocalAnswerProof, type LocalBankPreferences } from './library-types';
import { LOCAL_QUESTION_BANK_KEY, LOCAL_QUESTION_BANK_LIMIT, type LocalBankSaveResult } from './types';
import { isQuestionSnapshot } from '../question-answer/protocol';
import { createSimilarIndex } from './similar';

let repository: ReturnType<typeof createLocalBankRepository> | undefined;
let initializing: Promise<void> | undefined;
const listeners = new Set<() => void>();
let similarCache: { key: string; search: ReturnType<typeof createSimilarIndex> } | undefined;
export function onLocalBankChanged(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
async function changed() {
  similarCache = undefined;
  for (const listener of listeners) listener();
  await broadcastPublic({ type: 'toolbox:local-question-bank:changed' }, ['chaoxing', 'zjooc']);
}
export async function localBankRepository() {
  repository ??= createLocalBankRepository();
  initializing ??= (async () => {
    await privateStorageReady;
    const value: unknown = (await chrome.storage.local.get(LOCAL_QUESTION_BANK_KEY))[LOCAL_QUESTION_BANK_KEY];
    let legacy: BankEntry[] = [];
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('items' in value)
        || !Array.isArray(value.items) || value.items.length > LOCAL_QUESTION_BANK_LIMIT) throw new Error('旧版题库无法识别，请先备份并核对数据。');
      legacy = value.items.map((entry, i) => sanitizeBankEntry(entry, i));
    }
    await repository!.migrate(legacy);
    if (value !== undefined) await chrome.storage.local.remove(LOCAL_QUESTION_BANK_KEY);
  })().catch(error => { initializing = undefined; throw error; });
  await initializing; return repository;
}
export async function readStoredLocalBank(): Promise<BankEntry[]> {
  const repo = await localBankRepository(); const state = await repo.state();
  const enabled = new Set(state.libraries.filter(lib => lib.enabled).map(lib => lib.id));
  return (await repo.entries()).filter(entry => enabled.has(entry.libraryId)).map(entry => entry.record);
}
export async function saveStoredLocalBank(value: unknown): Promise<LocalBankSaveResult> {
  if (!Array.isArray(value) || !value.length || value.length > LOCAL_QUESTION_BANK_LIMIT) throw new Error('导入题目数量不符合要求。');
  const incoming = value.map((entry, i) => sanitizeBankEntry(entry, i));
  const repo = await localBankRepository(); const stored = await repo.entries();
  const identities = new Set(stored.map(entry => localBankEntryIdentity(entry.record)));
  const additions = incoming.filter(entry => { const id = localBankEntryIdentity(entry); if (identities.has(id)) return false; identities.add(id); return true; });
  if (additions.length) {
    await repo.importLibrary({ name: `外部 JSON 导入 ${new Date().toLocaleString('zh-CN')}`, course: '', filename: '', fileHash: '', format: 'bank-json',
      items: additions.map((record, i) => ({ record, number: String(i + 1), kindLabel: '', explanation: '', position: `JSON 第 ${i + 1} 题` })) });
    await changed();
  }
  return { added: additions.length, total: (await repo.state()).total };
}
export async function clearStoredLocalBank(): Promise<void> { await (await localBankRepository()).remove(); await changed(); }
export async function validateLocalAnswerProof(proof: LocalAnswerProof, context?: string) {
  return (!context || proof?.context === context) && await (await localBankRepository()).validate(proof);
}
export async function queryStoredLibraries(question: QuestionSnapshot, context: string) {
  const repo = await localBankRepository(); const state = await repo.state(context);
  return repo.match(question, state.preferences.enabled ? state.preferences.libraryIds : []);
}
const context = (sender: chrome.runtime.MessageSender) => bankCourseContext(sender.url);
const id = (value: unknown) => { if (typeof value !== 'string' || !value || value.length > 100) throw new Error('题库编号无效。'); return value; };
export const localQuestionBankRoutes: BackgroundRoutes = {
  'toolbox:local-libraries:similar': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: async (message, sender) => {
    if (!isQuestionSnapshot(message.question)) throw new Error('待检索题目无效。');
    const repo = await localBankRepository(); const state = await repo.state(context(sender));
    const chosen = state.preferences.enabled ? state.preferences.libraryIds : [];
    const libraries = state.libraries.filter(lib => lib.enabled && chosen.includes(lib.id));
    const key = JSON.stringify([state.revision, libraries.map(l => l.id).sort()]);
    if (similarCache?.key !== key) similarCache = { key, search: createSimilarIndex((await repo.entries()).filter(e => libraries.some(l => l.id === e.libraryId)), libraries) };
    const cache = similarCache; const candidates = cache.search(message.question);
    if ((await repo.state(context(sender))).revision !== state.revision || cache !== similarCache) throw new Error('题库已变化，请重新检索。');
    return { revision: state.revision, candidates };
  } },
  'toolbox:local-libraries:validate': { access: 'top-page', platforms: ['chaoxing', 'zjooc'], handle: async (message, sender) => validateLocalAnswerProof(message.proof as LocalAnswerProof, context(sender)) },
  'toolbox:local-libraries:edit': { access: 'options', handle: async message => {
    const result = await (await localBankRepository()).editEntry(id(message.id), message.version as number, message.draft as DraftEntry); await changed(); return result;
  } },
  'toolbox:local-libraries:undo': { access: 'options', handle: async message => {
    const result = await (await localBankRepository()).undoEntry(id(message.id), message.version as number); await changed(); return result;
  } },
  'toolbox:local-libraries:history': { access: 'options', handle: async message => (await localBankRepository()).entryHistory(id(message.id)) },
  'toolbox:local-libraries:backup': { access: 'options', handle: async () => (await localBankRepository()).exportData() },
  'toolbox:local-libraries:restore': { access: 'options', handle: async message => { await (await localBankRepository()).restoreData(message.backup); await changed(); } },
  'toolbox:saved:list': { access: 'options', handle: async () => (await localBankRepository()).saved() },
  'toolbox:saved:save': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: async (message, sender) => {
    const value = message.input;
    if (!value || typeof value !== 'object') throw new Error('收藏内容无效。');
    const input = { ...value, course: message.version === undefined ? context(sender) : (value as { course?: string }).course };
    const result = await (await localBankRepository()).saveQuestion(input, message.version as number | undefined);
    await broadcastPublic({ type: 'toolbox:saved:changed' }, ['chaoxing', 'zjooc']); return result;
  } },
  'toolbox:saved:mastered': { access: 'options', handle: async message => (await localBankRepository()).markMastered(id(message.id), message.version as number, message.mastered as boolean) },
  'toolbox:saved:remove': { access: 'options', handle: async message => {
    if (!Array.isArray(message.ids) || message.ids.length > 500 || !message.ids.every(v => typeof v === 'string' && /^[\w-]{1,100}$/.test(v))) throw new Error('收藏编号无效。');
    await (await localBankRepository()).removeSaved(message.ids as string[]);
  } },
  'toolbox:local-question-bank:read': { access: 'top-page', platforms: ['chaoxing', 'zjooc'], handle: async () => readStoredLocalBank() },
  'toolbox:local-question-bank:save': { access: 'top-page', platforms: ['chaoxing', 'zjooc'], handle: async message => saveStoredLocalBank(message.entries) },
  'toolbox:local-question-bank:clear': { access: 'top-page', platforms: ['chaoxing', 'zjooc'], handle: async () => clearStoredLocalBank() },
  'toolbox:local-libraries:status': { access: 'public', platforms: ['chaoxing', 'zjooc'], handle: async (_, sender) => (await localBankRepository()).state(context(sender)) },
  'toolbox:local-libraries:preferences': { access: 'top-page', platforms: ['chaoxing', 'zjooc'], handle: async (message, sender) => {
    await (await localBankRepository()).preferences(context(sender), message.preferences as LocalBankPreferences); await changed();
  } },
  'toolbox:local-libraries:entries': { access: 'options', handle: async message => (await localBankRepository()).entries(id(message.id)) },
  'toolbox:local-libraries:import': { access: 'options', handle: async message => {
    const result = await (await localBankRepository()).importLibrary(message.input as LibraryInput); if (!result.duplicate) await changed(); return result;
  } },
  'toolbox:local-libraries:update': { access: 'options', handle: async message => {
    if (!message.patch || typeof message.patch !== 'object') throw new Error('题库更新内容无效。');
    await (await localBankRepository()).update(id(message.id), message.patch); await changed();
  } },
  'toolbox:local-libraries:delete': { access: 'options', handle: async message => {
    const entryIds = message.entryIds;
    if (entryIds !== undefined && (!Array.isArray(entryIds) || !entryIds.length || entryIds.length > 2000 || !entryIds.every(value => typeof value === 'string' && value.length <= 100))) throw new Error('请选择要删除的题目。');
    await (await localBankRepository()).remove(id(message.id), entryIds as string[] | undefined); await changed();
  } },
};
