import { mountApiSettings } from '../features/api-settings/ui';
import { mountAppearanceSettings } from '../features/floating-toolbox/appearance-ui';
import { mountToolboxSettings } from '../features/toolbox-settings/ui';
import { mountUpdateCheck } from '../features/update-check/ui';
import { icon } from '../features/floating-toolbox/icons';
import { mountStudyNotificationSettings } from '../features/chapter-study/notification-settings';
import { mountQuestionBankSettings } from '../features/question-bank/ui';
import type { SettingsSection } from '../platform/settings-navigation';
import { mountConfigBackup } from '../features/config-backup/ui';
import { mountPacingSettings } from '../features/answer-pacing/ui';
import { mountLocalBankManager } from '../features/local-question-bank/manager-ui';
import { mountActivitySettings } from '../features/activity/ui';
import { mountSavedQuestions } from '../features/saved-questions/ui';

const sections = ['api', 'question-bank', 'features', 'floating'] as const;
const cleanups: Array<() => void> = [];
const brand = document.querySelector('.brand-mark');
if (brand) brand.innerHTML = icon('logo', 36);
const version = document.getElementById('version');
if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;
const updateRoot = document.getElementById('settings-update');
if (updateRoot) cleanups.push(mountUpdateCheck(updateRoot));

let disposeApi: (() => void) | undefined;
let disposeBank: (() => void) | undefined;
const apiRoot = document.getElementById('settings-api-form');
const bankRoot = document.getElementById('settings-bank-form');
const localRoot = document.getElementById('settings-local-bank');
if (localRoot) cleanups.push(mountLocalBankManager(localRoot));
const savedRoot = document.getElementById('settings-saved-questions');
if (savedRoot) cleanups.push(mountSavedQuestions(savedRoot));
function refreshCredentialForms(): void {
  disposeApi?.(); disposeBank?.();
  if (apiRoot) disposeApi = mountApiSettings(apiRoot);
  if (bankRoot) disposeBank = mountQuestionBankSettings(bankRoot);
}
refreshCredentialForms();
const activityRoot = document.getElementById('settings-activity');
const usageRoot = document.getElementById('settings-usage-overview');
if (activityRoot && usageRoot) cleanups.push(mountActivitySettings(activityRoot, usageRoot));
cleanups.push(() => { disposeApi?.(); disposeBank?.(); });
const backupRoot = document.getElementById('settings-config-backup');
if (backupRoot) cleanups.push(mountConfigBackup(backupRoot, refreshCredentialForms));

for (const [id, mount] of [
  ['features', mountToolboxSettings],
  ['floating', mountAppearanceSettings],
] as const) {
  const root = document.getElementById(`settings-${id}`);
  if (root) cleanups.push(mount(root));
}
const featureSettings = document.getElementById('settings-features');
if (featureSettings) {
  cleanups.push(mountStudyNotificationSettings(featureSettings));
  const pacingRoot = document.createElement('div');
  featureSettings.append(pacingRoot);
  cleanups.push(mountPacingSettings(pacingRoot));
}

function navigate(section: SettingsSection): void {
  document.querySelector<HTMLElement>('.page')!.dataset.section = section;
  for (const id of sections) {
    const panel = document.getElementById(`settings-${id}`);
    const link = document.querySelector<HTMLAnchorElement>(`a[href="#${id}"]`);
    if (panel) panel.hidden = id !== section;
    if (id === section) link?.setAttribute('aria-current', 'page');
    else link?.removeAttribute('aria-current');
  }
  const titles: Record<SettingsSection, string> = { api: 'AI 与用量设置', 'question-bank': '题库管理', features: '功能设置', floating: '悬浮框设置' };
  document.title = `${titles[section]} · 学习工具箱`;
}

function followHash(): void {
  const value = location.hash.slice(1);
  navigate(sections.includes(value as SettingsSection) ? value as SettingsSection : 'features');
}

const onMessage = (message: unknown, sender: chrome.runtime.MessageSender): void => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
  const data = message as { type?: unknown; section?: unknown };
  if (data.type !== 'toolbox:settings-section' || !sections.includes(data.section as SettingsSection)) return;
  location.hash = data.section as SettingsSection;
  followHash();
};

window.addEventListener('hashchange', followHash);
chrome.runtime.onMessage.addListener(onMessage);
window.addEventListener('unload', () => {
  for (const cleanup of cleanups) cleanup();
  window.removeEventListener('hashchange', followHash);
  chrome.runtime.onMessage.removeListener(onMessage);
}, { once: true });
followHash();
