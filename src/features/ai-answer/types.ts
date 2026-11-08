export interface CurrentQuestion {
  key: string;
  fingerprint: string;
  type: '简答题';
  stem: string;
  knowledgePoints: string[];
  assessment: string;
}

export type PageQuestionState =
  | { state: 'question'; question: CurrentQuestion }
  | { state: 'waiting' | 'complete' | 'unsupported'; message: string };

export interface AnswerSnapshot {
  ready: boolean;
  text: string;
  version: string;
  hasContent: boolean;
  error?: string;
}

export interface AnswerWriteRequest {
  question: CurrentQuestion;
  expectedVersion: string;
  text: string;
}

export interface AnswerWriteResult {
  ok: boolean;
  error?: string;
}

export type AiPhase = 'paused' | 'waiting' | 'needs-config' | 'blocked' | 'generating' | 'searched' | 'filled' | 'complete' | 'unsupported' | 'error';
export interface AiGeneratedAnswer { text: string; source?: string; localProof?: import('../local-question-bank/library-types').LocalAnswerProof }

export interface AiAnswerState {
  phase: AiPhase;
  running: boolean;
  message: string;
  question?: CurrentQuestion;
  answer: string;
  canConfirmReplace: boolean;
  mode?: 'fill' | 'search';
  source?: string;
  applyNeedsReplace?: boolean;
}

export interface AiAnswerController {
  getState(): AiAnswerState;
  subscribe(listener: (state: AiAnswerState) => void): () => void;
  start(): void;
  stop(): void;
  confirmReplace(): void;
  retry(): void;
  settingsChanged(): void;
  setMode?(mode: 'fill' | 'search'): void;
  applyResult?(replace?: boolean): void;
  dispose(): void;
}

export interface AiControllerDependencies {
  document: Document;
  isEnabled(): boolean;
  apiConfigured(): Promise<boolean>;
  readAnswer(): Promise<AnswerSnapshot>;
  writeAnswer(request: AnswerWriteRequest): Promise<AnswerWriteResult>;
  generate(question: CurrentQuestion, signal: AbortSignal, onProgress: (text: string) => void, onStatus?: (text: string) => void): Promise<string | AiGeneratedAnswer>;
  validateResult?(result: AiGeneratedAnswer): Promise<boolean>;
  waitBeforeFill?: import('../answer-pacing/scheduler').PacingWait;
}
