import { requestExtension } from '../../core/extension-rpc';
import type { ApiConfig, ApiStatus, ApiSettings } from './types';

export const readApiConfig = (): Promise<ApiConfig> => requestExtension('toolbox:api:read');
export const saveApiConfig = (config: ApiConfig): Promise<void> => requestExtension('toolbox:api:save', { config });
export const clearApiConfig = (): Promise<void> => requestExtension('toolbox:api:clear');
export const getApiStatus = (): Promise<ApiStatus> => requestExtension('toolbox:api:status');
export const testApiConnection = (profileId?: string): Promise<{ message: string; latencyMs: number }> => requestExtension('toolbox:api:test', { profileId });
export const readApiSettings = (): Promise<ApiSettings> => requestExtension('toolbox:api:profiles');
export const saveApiSettings = (settings: ApiSettings): Promise<void> => requestExtension('toolbox:api:profiles-save', { settings });

export function subscribeApiStatus(listener: () => void): () => void {
  const onMessage = (message: { type?: string }, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'toolbox:api:changed') listener();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}
