import type { BankEntry } from '../answer-exchange/types';
import type { LocalBankMatch } from './types';

export interface DraftEntry {
  record: BankEntry;
  number: string;
  kindLabel: string;
  explanation: string;
  position: string;
}
export interface BankDraft {
  name: string; course: string; declaredCount: number; items: DraftEntry[];
  issues: Array<{ position: string; message: string }>;
  duplicates: number; conflicts: number;
}
export interface LibraryInput {
  name: string; course: string; filename: string; fileHash: string; format: string; items: DraftEntry[];
}
export interface LibraryInfo {
  id: string; name: string; course: string; filename: string; fileHash: string; format: string;
  createdAt: string; enabled: boolean; count: number; conflicts: number;
}
export interface StoredEntry extends DraftEntry { id: string; libraryId: string; contentKey: string; answerKey: string; version?: number; updatedAt?: string }
export interface EntryRevision { id: string; entryId: string; version: number; previous: DraftEntry; changedAt: string }
export interface LocalBankPreferences { enabled: boolean; onlineFallback: boolean; libraryIds: string[] }
export const defaultLocalPreferences = (): LocalBankPreferences => ({ enabled: false, onlineFallback: false, libraryIds: [] });
export interface LibraryState {
  revision: number; libraries: LibraryInfo[]; total: number; preferences: LocalBankPreferences;
}
export interface LibraryMatch extends LocalBankMatch {
  revision: number; sources: Array<{ libraryId: string; entryId: string; name: string; number: string; position: string }>;
}
export interface LocalAnswerProof { revision: number; libraryIds: string[]; entryIds: string[]; context: string }

/** Stable course identifiers only; never persist the URL or its authentication query. */
export function bankCourseContext(raw?: string): string {
  try {
    const url = new URL(raw!);
    if (url.hostname === 'www.zjooc.cn' || url.hostname === 'zjooc.cn') {
      const id = url.pathname.match(/\/course\/study\/([\w-]{1,100})(?:\/|$)/)?.[1];
      if (id) return `zjooc:${id}`;
      const path = url.hash.startsWith('#/') ? url.hash.slice(1).split('?')[0] : url.pathname;
      const identifiers = ['examId', 'paperId', 'testId'].map(key => [key, url.searchParams.get(key) ?? '']);
      let hash = 2166136261;
      for (const char of JSON.stringify([path, identifiers])) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return `zjooc:manual:${(hash >>> 0).toString(16)}`;
    }
    if (url.hostname.endsWith('.chaoxing.com') || url.hostname === 'chaoxing.com') {
      const id = url.searchParams.get('courseId') ?? url.searchParams.get('courseid');
      return `chaoxing:${id && /^[\w-]{1,100}$/.test(id) ? id : 'manual'}`;
    }
  } catch { /* Settings pages use the general manager context. */ }
  return 'manager';
}
