import { requestExtension } from '../../core/extension-rpc';
import type { DraftEntry, EntryRevision, LibraryInfo, LibraryInput, LibraryState, LocalBankPreferences, StoredEntry } from './library-types';

export const getLibraryState = (): Promise<LibraryState> => requestExtension('toolbox:local-libraries:status');
export const getLibraryEntries = (id: string): Promise<StoredEntry[]> => requestExtension('toolbox:local-libraries:entries', { id });
export const importLibrary = (input: LibraryInput): Promise<{ library: LibraryInfo; duplicate: boolean }> => requestExtension('toolbox:local-libraries:import', { input });
export const updateLibrary = (id: string, patch: { name?: string; enabled?: boolean }): Promise<void> => requestExtension('toolbox:local-libraries:update', { id, patch });
export const deleteLibrary = (id: string, entryIds?: string[]): Promise<void> => requestExtension('toolbox:local-libraries:delete', { id, entryIds });
export const editLibraryEntry = (id: string, version: number, draft: DraftEntry): Promise<StoredEntry> => requestExtension('toolbox:local-libraries:edit', { id, version, draft });
export const undoLibraryEntry = (id: string, version: number): Promise<StoredEntry> => requestExtension('toolbox:local-libraries:undo', { id, version });
export const getEntryHistory = (id: string): Promise<EntryRevision[]> => requestExtension('toolbox:local-libraries:history', { id });
export const saveLibraryPreferences = (preferences: LocalBankPreferences): Promise<void> => requestExtension('toolbox:local-libraries:preferences', { preferences });
export function subscribeLibraries(listener: () => void): () => void {
  const changed = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'toolbox:local-question-bank:changed') listener();
  };
  chrome.runtime.onMessage.addListener(changed); return () => chrome.runtime.onMessage.removeListener(changed);
}
