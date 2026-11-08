import { requestExtension } from '../core/extension-rpc';
import { createAiAnswerController } from '../features/ai-answer/controller';
import { generateAnswer } from '../features/ai-answer/client';
import { createEditorClient } from '../features/ai-answer/editor-client';
import type { AiAnswerController } from '../features/ai-answer/types';
import { getApiStatus, subscribeApiStatus } from '../features/api-settings/client';
import { installFloatingPanel, type FloatingPanelController } from '../features/floating-toolbox';
import { readUiPreferences, writeUiPreferences, subscribeUiPreferences } from '../features/floating-toolbox/client';
import { normalizeToolboxView } from '../features/floating-toolbox/preferences';
import { installQuestionExtraction } from '../features/question-extract/content';
import { openSettings } from '../platform/settings-navigation';
import { readSettings, subscribeSettings, writeSettings } from '../platform/storage';
import { bridgeMessage, connectIsolatedBridge } from '../shared/bridge';
import { COLLECT_QUESTIONS, OPEN_PANEL, type ExtractionResponse, type PageStatus } from '../shared/messages';
import { defaultSettings, isFeatureEnabled, type Settings } from '../shared/settings';
import { createStudyFrameClient } from '../features/chapter-study/client';
import { createStudyController } from '../features/chapter-study/controller';
import type { StudyController } from '../features/chapter-study/types';
import { getDocumentPlatform } from '../shared/sites';
import { isFeatureSupported } from '../features/catalog';
import { createZjoocStudyController } from '../features/zjooc-study/controller';
import { createZjoocStudyClient } from '../features/zjooc-study/client';
import type { ZjoocStudyController } from '../features/zjooc-study/types';
import {
  createQuestionAnswerClient, generateQuestionAnswer, getAnswerSourcesStatus, reviewQuestionAnswers,
  saveAnswerSource, subscribeAnswerSource,
} from '../features/question-answer/client';
import { createQuestionAnswerController, type ChapterAnswerController } from '../features/question-answer/controller';
import { canPreviewQuestions } from '../features/question-answer/permissions';
import { subscribeQuestionBankStatus } from '../features/question-bank/client';
import { subscribeLibraries } from '../features/local-question-bank/library-client';
import { readAnswerPacing, subscribeAnswerPacing } from '../features/answer-pacing/client';
import { createFillPacer } from '../features/answer-pacing/scheduler';
import { createIsolatedAnswerBridge } from '../features/question-answer/isolated-bridge';
import { observePageContext } from '../platform/page-context';
import { planAnswerSource } from '../features/question-answer/source-status';
import { createPaperFlowController, type PaperFlowProgress } from '../features/question-answer/flow-controller';

function install(): void {
  const identified = getDocumentPlatform(window);
  if (!identified) return;
  const platform = identified;
  let settings = { ...defaultSettings(), enabled: false };
  let loaded = false;
  let revision = 0;
  let storageEvents = 0;
  let status: PageStatus = { ready: false, enabled: false, activeFeatures: [], errors: [] };
  let floatingPanel: FloatingPanelController | undefined;
  let ai: AiAnswerController | undefined;
  let questionAnswer: ChapterAnswerController | undefined;
  let study: StudyController | undefined;
  let zjoocStudy: ZjoocStudyController | undefined;

  function apply(next: Settings): void {
    const aiChanged = settings.enabled !== next.enabled || settings.features['ai-answer'] !== next.features['ai-answer'];
    const answerChanged = aiChanged || settings.features['question-answer'] !== next.features['question-answer'];
    settings = next;
    loaded = true;
    revision += 1;
    status = { ready: platform.id === 'zjooc', enabled: settings.enabled,
      activeFeatures: platform.id === 'zjooc' ? (['zjooc-study', 'question-answer', 'ai-answer'] as const).filter(id => isFeatureEnabled(settings, id)) : [], errors: [] };
    bridge?.send(bridgeMessage({ kind: 'apply', revision, settings }));
    if (aiChanged) ai?.settingsChanged();
    if (answerChanged) questionAnswer?.settingsChanged();
    answerClient?.settingsChanged();
    studyClient?.settingsChanged();
    study?.settingsChanged();
    zjoocStudy?.settingsChanged();
    floatingPanel?.update(settings);
  }

  const bridge = platform.id === 'chaoxing' ? connectIsolatedBridge(window, (message) => {
    studyClient?.receive(message);
    answerClient?.receive(message);
    if (message.kind === 'editor-result') editorClient?.receive(message);
    else if (message.kind === 'ready' && loaded) bridge?.send(bridgeMessage({ kind: 'apply', revision, settings }));
    else if (message.kind === 'applied' && message.revision === revision && loaded) {
      const active = message.activeFeatures.filter(id => isFeatureSupported(id, platform.id));
      if (isFeatureEnabled(settings, 'question-extract')) active.push('question-extract');
      if (isFeatureEnabled(settings, 'ai-answer')) active.push('ai-answer');
      if (isFeatureEnabled(settings, 'question-answer')) active.push('question-answer');
      status = { ready: true, enabled: settings.enabled, activeFeatures: active, errors: message.errors };
    }
  }) : createIsolatedAnswerBridge(window, message => answerClient?.receive(message));
  const editorClient = bridge && platform.id === 'chaoxing' ? createEditorClient(bridge) : undefined;
  const studyClient = bridge && platform.id === 'chaoxing' ? createStudyFrameClient(bridge, () => loaded ? settings : undefined) : undefined;
  const answerClient = bridge ? createQuestionAnswerClient(bridge, () => loaded ? settings : undefined, window) : undefined;
  subscribeSettings((next) => { storageEvents += 1; apply(next); });
  const startEvents = storageEvents;
  const initialSettings = readSettings().then((next) => {
    if (storageEvents === startEvents) apply(next);
  }).catch(() => { status.errors = ['无法读取设置，请重新加载扩展并刷新页面。']; });
  if (platform.id === 'chaoxing') installQuestionExtraction(() => loaded ? settings : undefined, initialSettings);

  if (window === window.top) {
    const waitBeforeFill = createFillPacer({ minimum: async () => (await readAnswerPacing()).minimumQuestionMs });
    if (answerClient) {
      questionAnswer = createQuestionAnswerController({
        runtime: answerClient.runtime,
        isEnabled: () => loaded && isFeatureEnabled(settings, 'question-answer'),
        canPreview: () => loaded && canPreviewQuestions(settings),
        getSources: getAnswerSourcesStatus,
        saveSource: saveAnswerSource,
        generate: generateQuestionAnswer,
        review: reviewQuestionAnswers,
        waitBeforeFill,
        history: {
          load: questions => requestExtension('toolbox:history:load', { questions }),
          clear: () => requestExtension('toolbox:history:clear'),
        },
      });
      const answer = questionAnswer; const stopAnswer = answer.stop.bind(answer);
      const flow = createPaperFlowController({ runtime: answerClient.runtime, answer, stopAnswer,
        isEnabled: () => loaded && isFeatureEnabled(settings, 'question-answer'),
        load: () => requestExtension<PaperFlowProgress | undefined>('toolbox:paper-flow:load'),
        save: progress => requestExtension('toolbox:paper-flow:save', { progress }),
        clear: () => requestExtension('toolbox:paper-flow:clear'),
      });
      answer.flow = flow; answer.stop = () => { flow.stop(); stopAnswer(); };
      window.addEventListener('pagehide', () => flow.stop());
    }
    if (platform.id === 'chaoxing' && studyClient && editorClient && questionAnswer) {
      const answer = questionAnswer;
      study = createStudyController({ document, isEnabled: () => loaded && isFeatureEnabled(settings, 'chapter-study'), runtime: studyClient.runtime,
        chapterTestHandler: async (target, context) => {
          if (context.preferences.chapterAnswer === false) return { status: 'skipped', message: '章节测验自动答题已关闭，需手动完成。' };
          return answer.runChapter(target, context.signal, context.preferences.chapterAnswerFinish ?? 'save');
        },
      });
      ai = createAiAnswerController({
        document,
        isEnabled: () => loaded && isFeatureEnabled(settings, 'ai-answer'),
        apiConfigured: async () => { const value = await getAnswerSourcesStatus(); return Boolean(planAnswerSource(value.selection ?? (value.local?.enabled ? 'local' : 'ai'), value).first); },
        readAnswer: editorClient.readAnswer,
        writeAnswer: editorClient.writeAnswer,
        generate: generateAnswer,
        validateResult: async result => !result.localProof || await requestExtension<boolean>('toolbox:local-libraries:validate', { proof: result.localProof }),
        waitBeforeFill,
      });
    } else if (platform.id === 'zjooc') {
      zjoocStudy = createZjoocStudyController({ document, isEnabled: () => loaded && isFeatureEnabled(settings, 'zjooc-study'),
        getPlaybackRate: () => settings.zjoocPlaybackRate, getStartMode: () => settings.zjoocStartMode, runtime: createZjoocStudyClient() });
    }
    floatingPanel = installFloatingPanel({
      platform,
      getSettings: () => loaded ? settings : undefined,
      saveSettings: async (update) => {
        const current = await readSettings();
        const next = update(current);
        await writeSettings(next);
        const stored = await readSettings();
        if (JSON.stringify(settings) !== JSON.stringify(stored)) apply(stored);
      },
      extract: async () => {
        await initialSettings;
        if (platform.id !== 'chaoxing' || !loaded || !isFeatureEnabled(settings, 'question-extract')) return { ok: false, error: '请在学习通开启工具箱和题目提取功能。' };
        return requestExtension<ExtractionResponse>(COLLECT_QUESTIONS);
      },
      openSettings,
      getApiStatus,
      ai,
      questionAnswer,
      study,
      zjoocStudy,
      loadUiPreferences: readUiPreferences,
      saveUiPreferences: writeUiPreferences,
      version: chrome.runtime.getManifest().version,
    });
    subscribeApiStatus(() => { ai?.settingsChanged(); questionAnswer?.settingsChanged(); floatingPanel?.update(settings); });
    subscribeQuestionBankStatus(() => { questionAnswer?.settingsChanged(); floatingPanel?.update(settings); });
    subscribeLibraries(() => { ai?.settingsChanged(); questionAnswer?.settingsChanged(); floatingPanel?.update(settings); });
    subscribeAnswerSource(() => { ai?.settingsChanged(); questionAnswer?.settingsChanged(); floatingPanel?.update(settings); });
    subscribeAnswerPacing(() => { ai?.settingsChanged(); questionAnswer?.settingsChanged(); floatingPanel?.update(settings); });
    subscribeUiPreferences((preferences) => floatingPanel?.updatePreferences?.(preferences));
    observePageContext(document, context => {
      if (context !== 'chapter' && study?.getState().running) study.stop();
      if (context !== 'chapter' && zjoocStudy?.getState().running) zjoocStudy.stop();
      if (questionAnswer?.getState().running) questionAnswer.stop();
      if (context !== 'think-ladder' && ai?.getState().running) ai.stop();
    });
  }

  window.addEventListener('pagehide', () => { questionAnswer?.stop(); answerClient?.runtime.cancel(); });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'toolbox:get-status') sendResponse(status);
    else if (message?.type === OPEN_PANEL && floatingPanel) {
      floatingPanel.open(normalizeToolboxView(message.view));
      sendResponse({ ok: true });
    }
  });
}

install();
