import { createAiAnswerView } from './ai-answer/ui';
import { aiAnswerStyles } from './ai-answer/ui/styles';
import { isThinkLadderUrl } from './ai-answer/adapters/think-ladder';
import type { AiAnswerController } from './ai-answer/types';
import type { ApiStatus } from './api-settings/types';
import { createChapterStudyView } from './chapter-study/ui';
import { chapterStudyStyles } from './chapter-study/styles';
import { isChapterStudyUrl } from './chapter-study/adapters/chapter';
import type { StudyController } from './chapter-study/types';
import { createPageToolsView, createSceneToolsView } from './page-tools/ui';
import { questionExtractStyles } from './question-extract/ui/styles';
import type { ExtractionResponse } from '../shared/messages';
import type { Settings } from './toolbox-settings/types';
import type { SettingsSection } from '../platform/settings-navigation';
import type { ToolboxView } from './floating-toolbox/preferences';
import { pageToolsTitle, pageContextFromUrl, type PageContext } from '../platform/page-context';
import { getPlatform, type PlatformId } from '../shared/sites';
import { createZjoocStudyView } from './zjooc-study/ui';
import { zjoocStudyStyles } from './zjooc-study/styles';
import type { ZjoocStudyController } from './zjooc-study/types';
import type { QuestionAnswerController } from './question-answer/types';
import { questionAnswerStyles } from './question-answer/styles';
import { answerExchangeStyles } from './answer-exchange/styles';

export interface WorkspaceView {
  element: HTMLElement;
  /** Optional controls owned by the view, mounted in the shell's fixed action row. */
  actions?: HTMLElement;
  update(settings: Settings | undefined, saving: boolean): void;
  refresh?(): void;
  updatePage?(context: PageContext): void;
  dispose(): void;
}

export interface WorkspaceContext {
  getSettings(): Settings | undefined;
  saveSettings(update: (current: Settings) => Settings): Promise<void>;
  extract(): Promise<ExtractionResponse>;
  openSettings(section?: SettingsSection): Promise<void>;
  getApiStatus(): Promise<ApiStatus>;
  ai?: AiAnswerController;
  questionAnswer?: QuestionAnswerController;
  study?: StudyController;
  zjoocStudy?: ZjoocStudyController;
}

/** Register feature workspaces here; the floating shell only reads descriptors. */
export const WORKSPACES: ReadonlyArray<{
  id: ToolboxView;
  platform: PlatformId;
  title: string;
  titleOnPage?(context: PageContext): string;
  icon: 'extract' | 'ai' | 'study';
  defaultOnPage?(url: string): boolean;
  visibleOnPage?(context: PageContext): boolean;
  create(context: WorkspaceContext): WorkspaceView;
}> = [
  { id: 'page-tools', platform: 'chaoxing', title: '页面工具', titleOnPage: pageToolsTitle, icon: 'extract', visibleOnPage: scene => scene !== 'chapter' && scene !== 'think-ladder', create: createPageToolsView },
  { id: 'answer', platform: 'chaoxing', title: '思维阶梯', icon: 'ai', visibleOnPage: scene => scene === 'think-ladder', defaultOnPage: isThinkLadderUrl, create(context) {
    if (!context.ai) throw new Error('Missing Chaoxing answer controller');
    const view = createAiAnswerView({ ...context, ai: context.ai, supported: isThinkLadderUrl(location.href) });
    const tools = createSceneToolsView(context);
    const element = document.createElement('section');
    element.append(view.element, tools.element);
    return { element, update(settings, saving) { view.update(settings, saving); tools.update(settings, saving); }, refresh: view.refreshApiStatus, dispose() { view.dispose(); tools.dispose(); element.remove(); } };
  } },
  { id: 'chapter-study', platform: 'chaoxing', title: '章节学习', icon: 'study', visibleOnPage: scene => scene === 'chapter', defaultOnPage: isChapterStudyUrl, create(context) {
    if (!context.study) throw new Error('Missing Chaoxing study controller');
    return createChapterStudyView({ ...context, study: context.study });
  } },
  { id: 'zjooc-study', platform: 'zjooc', title: '章节学习', icon: 'study', visibleOnPage: scene => scene !== 'exam' && scene !== 'homework', create: createZjoocStudyView },
  { id: 'zjooc-exam', platform: 'zjooc', title: '考试', titleOnPage: pageToolsTitle, icon: 'extract', visibleOnPage: scene => scene === 'exam' || scene === 'homework', create: createPageToolsView },
];

export function getWorkspaces(platformId?: PlatformId, context?: PageContext): typeof WORKSPACES {
  return WORKSPACES.filter(workspace => workspace.platform === platformId && (context === undefined || !workspace.visibleOnPage || workspace.visibleOnPage(context)));
}

export function getDefaultWorkspace(url: string): ToolboxView {
  const workspaces = getWorkspaces(getPlatform(url)?.id, pageContextFromUrl(url));
  return workspaces.find((workspace) => workspace.defaultOnPage?.(url))?.id ?? workspaces[0]?.id ?? 'page-tools';
}

/** Older open-panel requests still open the current scene instead of an unrelated tab. */
export function resolveSceneWorkspace(platformId: PlatformId, context: PageContext, requested?: ToolboxView): ToolboxView {
  const visible = getWorkspaces(platformId, context);
  return visible.find(workspace => workspace.id === requested)?.id ?? visible[0]?.id ?? 'page-tools';
}

export const workspaceStyles = [questionExtractStyles, aiAnswerStyles, questionAnswerStyles, answerExchangeStyles, chapterStudyStyles, zjoocStudyStyles].join('\n');
