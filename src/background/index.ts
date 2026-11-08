import { canAccess, privateStorageReady, type BackgroundRoutes } from '../core/background-context';
import { apiSettingsRoutes, subscribeStoredApi } from '../features/api-settings/background';
import { installAiGenerationBroker } from '../features/ai-answer/background';
import { uiRoutes, subscribeStoredUi } from '../features/floating-toolbox/background';
import { extractFromTab } from '../features/question-extract/client';
import { settingsRoutes, subscribeStoredSettings } from '../features/toolbox-settings/background';
import { COLLECT_QUESTIONS, OPEN_SETTINGS } from '../shared/messages';
import { studyRoutes, installStudyBroker } from '../features/chapter-study/background';
import { studyNotificationRoutes, installStudyNotifications } from '../features/chapter-study/notifications';
import { zjoocStudyRoutes, installZjoocStudyBackground } from '../features/zjooc-study/background';
import { updateCheckRoutes } from '../features/update-check/background';
import { questionBankRoutes, subscribeStoredQuestionBank } from '../features/question-bank/background';
import { installQuestionAnswerBroker } from '../features/question-answer/background';
import { installQuestionGenerationBroker } from '../features/question-answer/generation-background';
import { answerSourceRoutes, subscribeStoredAnswerSource } from '../features/question-answer/source-background';
import { configBackupRoutes } from '../features/config-backup/background';
import { pacingRoutes, subscribeStoredPacing } from '../features/answer-pacing/background';
import { localQuestionBankRoutes } from '../features/local-question-bank/background';
import { activityRoutes } from '../features/activity/background';
import { paperFlowRoutes } from '../features/question-answer/flow-background';

async function showSettings(section: unknown): Promise<void> {
  const view = section === 'api' || section === 'floating' || section === 'question-bank' ? section : 'features';
  const base = chrome.runtime.getURL('options/index.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const existing = contexts.find((context) => context.documentUrl?.split('#')[0] === base && context.tabId >= 0);
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true, url: `${base}#${view}` });
    if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: `${base}#${view}` });
}

const routes: BackgroundRoutes = {
  ...settingsRoutes,
  ...apiSettingsRoutes,
  ...questionBankRoutes,
  ...localQuestionBankRoutes,
  ...activityRoutes,
  ...paperFlowRoutes,
  ...configBackupRoutes,
  ...pacingRoutes,
  ...answerSourceRoutes,
  ...uiRoutes,
  ...studyRoutes,
  ...studyNotificationRoutes,
  ...zjoocStudyRoutes,
  ...updateCheckRoutes,
  [COLLECT_QUESTIONS]: { access: 'top-page', platforms: ['chaoxing'], handle: async (_message, sender) => extractFromTab(sender.tab!.id!) },
  [OPEN_SETTINGS]: { access: 'public', handle: async (message) => showSettings(message.section) },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
  const route = Object.hasOwn(routes, message.type) ? routes[message.type] : undefined;
  if (!route || !canAccess(route.access, sender, route.platforms)) return;
  void privateStorageReady.then(() => route.handle(message, sender)).then((value) => {
    sendResponse({ ok: true, value });
  }).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' });
  });
  return true;
});

subscribeStoredSettings();
subscribeStoredApi();
subscribeStoredPacing();
subscribeStoredQuestionBank();
subscribeStoredAnswerSource();
subscribeStoredUi();
installAiGenerationBroker();
installQuestionAnswerBroker();
installQuestionGenerationBroker();
installStudyBroker();
installStudyNotifications();
installZjoocStudyBackground();
