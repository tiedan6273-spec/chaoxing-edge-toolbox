import type { ZjoocStartPosition } from './start-position';

export type ZjoocStudyPhase = 'disabled' | 'unsupported' | 'waiting' | 'running' | 'confirming' | 'paused' | 'complete';

export interface ZjoocStudyState {
  phase: ZjoocStudyPhase;
  running: boolean;
  message: string;
  projectTitle: string;
  chapterTitle: string;
  resourceTitle: string;
  playbackRate?: number;
  availablePlaybackRates: number[];
  completed: number;
  pendingConfirmation: string[];
  skipped: string[];
}

export interface ZjoocStudyProcessed {
  resourceId: string;
  chapterIndex: number;
  kind: 'video' | 'courseware';
  outcome: 'ended' | 'submitted';
  refreshed?: boolean;
}
export interface ZjoocStudySession {
  courseKey: string;
  paused: boolean;
  start?: ZjoocStartPosition;
  cursor?: { chapterIndex: number; resourceId?: string };
  processed?: ZjoocStudyProcessed[];
}

export interface ZjoocStudyRuntime {
  readSession(courseKey: string): Promise<ZjoocStudySession | undefined>;
  writeSession(session: ZjoocStudySession): Promise<void>;
}

export interface ZjoocStudyController {
  getState(): ZjoocStudyState;
  subscribe(listener: (state: ZjoocStudyState) => void): () => void;
  start(recheck?: boolean): void;
  startFromCurrent(): void;
  stop(): void;
  settingsChanged(): void;
  dispose(): void;
}
