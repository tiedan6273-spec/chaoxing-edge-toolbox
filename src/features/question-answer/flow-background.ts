import type { BackgroundRoutes } from '../../core/background-context';
import type { PaperFlowProgress } from './flow-controller';

const key = (sender: chrome.runtime.MessageSender) => `toolbox.paper-flow.${sender.tab!.id}`;
export function validateFlowProgress(value: unknown): value is PaperFlowProgress {
  if (!value || typeof value !== 'object') return false; const v = value as PaperFlowProgress;
  return typeof v.attemptKey === 'string' && /^paper:[\w.-]+:[\w-]+$/.test(v.attemptKey) && v.attemptKey.length <= 200
    && Array.isArray(v.visited) && v.visited.length <= 1000 && v.visited.every(s => typeof s === 'string' && /^[\w-]{1,100}$/.test(s))
    && new Set(v.visited).size === v.visited.length && ['pages','processed','filled','saved'].every(k => { const n = v[k as keyof PaperFlowProgress]; return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 300000; })
    && v.pages === v.visited.length && v.saved <= v.processed && v.filled <= v.processed;
}
export const paperFlowRoutes: BackgroundRoutes = {
  'toolbox:paper-flow:load': { access: 'top-page', platforms: ['chaoxing','zjooc'], handle: async (_, sender) => {
    const value: unknown = (await chrome.storage.session.get(key(sender)))[key(sender)]; return validateFlowProgress(value) ? value : undefined;
  } },
  'toolbox:paper-flow:save': { access: 'top-page', platforms: ['chaoxing','zjooc'], handle: async (message, sender) => {
    if (!validateFlowProgress(message.progress)) throw new Error('跨页进度无效，未保存。'); await chrome.storage.session.set({ [key(sender)]: message.progress });
  } },
  'toolbox:paper-flow:clear': { access: 'top-page', platforms: ['chaoxing','zjooc'], handle: async (_, sender) => chrome.storage.session.remove(key(sender)) },
};
