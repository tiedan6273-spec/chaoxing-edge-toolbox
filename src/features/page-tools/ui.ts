import { pageToolsTitle, readPageContext, type PageContext } from '../../platform/page-context';
import { createAllowPasteView } from '../allow-paste/ui';
import { createQuestionExtractView } from '../question-extract/ui';
import type { Settings } from '../toolbox-settings/types';
import type { WorkspaceContext, WorkspaceView } from '../workspace-registry';
import { createQuestionAnswerView } from '../question-answer/ui';
import { getPlatform } from '../../shared/sites';

/** Scenes with a shared question grid reuse its preview/copy UI instead of mounting extraction again. */
export function createSceneToolsView(dependencies: WorkspaceContext, options: { includeExtraction?: boolean } = {}): WorkspaceView {
  const includeExtraction = options.includeExtraction ?? true;
  const root = document.createElement('details');
  root.className = 'scene-tools';
  const summary = document.createElement('summary');
  summary.textContent = includeExtraction ? '提取与复制 · 允许粘贴' : '允许粘贴';
  const content = document.createElement('div');
  content.className = 'scene-tools-content';
  const paste = createAllowPasteView(dependencies);
  const extraction = includeExtraction ? createQuestionExtractView(dependencies) : undefined;
  content.append(paste.element);
  if (extraction) content.append(extraction.element);
  root.append(summary, content);
  return {
    element: root,
    update(settings, saving) { paste.update(settings, saving); extraction?.update(settings, saving); },
    dispose() { paste.dispose(); extraction?.dispose(); root.remove(); },
  };
}

/** A scene workspace composes feature views without owning their behavior or drafts. */
export function createPageToolsView(dependencies: WorkspaceContext): WorkspaceView {
  const root = document.createElement('section');
  root.className = 'page-tools-workspace';
  const scene = readPageContext(document);
  const answer = dependencies.questionAnswer && (scene === 'homework' || scene === 'exam')
    ? createQuestionAnswerView({ answer: dependencies.questionAnswer, openSettings: dependencies.openSettings, title: pageToolsTitle(scene) }) : undefined;
  const tools = getPlatform(location.href)?.id === 'chaoxing' ? createSceneToolsView(dependencies, { includeExtraction: !answer }) : undefined;
  if (answer) root.append(answer.element);
  else if (tools) (tools.element as HTMLDetailsElement).open = true;
  if (tools) root.append(tools.element);
  return {
    element: root,
    actions: answer?.actions,
    update(settings: Settings | undefined, saving: boolean): void {
      answer?.update(settings, saving);
      tools?.update(settings, saving);
    },
    updatePage(context: PageContext): void { root.setAttribute('aria-label', `${pageToolsTitle(context)}辅助工具`); },
    refresh(): void { answer?.refresh?.(); },
    dispose(): void { answer?.dispose(); tools?.dispose(); root.remove(); },
  };
}
