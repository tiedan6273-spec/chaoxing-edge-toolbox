export type QuestionKind = 'single' | 'multiple' | 'judgement' | 'completion' | 'line' | 'fill' | 'reader' | 'program' | 'unsupported';
export type AnswerSourceMode = 'prefer-bank' | 'bank' | 'ai' | 'local';
export type AnswerSource = 'bank' | 'bank-ai' | 'ai' | 'import' | 'local-bank';
export type CompletionPolicy = 'save' | 'submit' | 'stay';
export type AnswerMode = 'fill' | 'search';
export type AnswerRange = 'all' | 'current' | 'forward';
export const ANSWER_PREFERENCES_KEY = 'toolbox.question-answer.preferences.v1';
export interface AnswerSourcesStatus {
  selection: AnswerSourceMode | null;
  bank: { configured: boolean; authorized: boolean };
  ai: { configured: boolean; authorized: boolean; enabled: boolean; supportsImages?: boolean };
  local?: { enabled: boolean; onlineFallback: boolean; selectedCount: number; revision: number };
}
export interface QuestionOption { id: string; label: string; text: string }
export interface QuestionField { id: string; options?: QuestionOption[] }
/** Programming questions carry the language selected on the page; the code itself is an answer. */
export interface QuestionProgram { language: string }
export interface QuestionChild { id: string; stem: string; options: QuestionOption[] }
export const QUESTION_MARKDOWN_LIMIT = 128_000;
export interface QuestionTextRecognition {
  status: 'pending' | 'partial' | 'unavailable';
  unresolvedCount: number;
  /** Page source codes, explicitly not the recovered visible text. */
  unresolved: Array<{ raw: string; count: number }>;
}
export interface QuestionSnapshot {
  key: string; fingerprint: string; number: string; kind: QuestionKind; stem: string;
  options: QuestionOption[]; fields: QuestionField[]; children: QuestionChild[]; images: string[];
  supported: boolean; reason?: string;
  program?: QuestionProgram;
  textRecognition?: QuestionTextRecognition;
  /** Read-only, fully formatted copy text captured alongside the question; never an answer input. */
  markdown?: string;
  /** Platform review data, never a provider input or a claimed standard answer. */
  reviewData?: { answer: ApplicableAnswer; score?: string; maxScore?: string; explanation: string };
}
export interface ApplicableAnswer {
  choices?: string[]; texts?: string[]; matches?: string[]; code?: string;
  children?: Array<{ id: string; choices: string[] }>;
}
export interface AnswerControlSnapshot {
  ready: boolean; version: string; hasContent: boolean; complete: boolean; answer: ApplicableAnswer; error?: string;
}
export interface QuestionPageSnapshot {
  documentKey: string; scopeKey: string; scene: 'chapter-test' | 'homework' | 'exam' | 'unsupported';
  questions: QuestionSnapshot[]; complete: boolean; allLoaded: boolean; canSave: boolean; canSubmit: boolean; reason?: string;
}
export interface QuestionTarget {
  frameId: number; documentId?: string; documentKey: string; scopeKey: string; question: QuestionSnapshot;
}
export interface ImportedAnswer { target: QuestionTarget; answer: ApplicableAnswer }
export interface PreparedQuestion {
  question: QuestionSnapshot; images: string[]; suggestionTitle: string; suggestionOptions: string;
}
export interface AnswerResult {
  status: 'answer' | 'no-answer'; source: AnswerSource; text: string; answer?: ApplicableAnswer;
  tags?: Array<{ text: string; title?: string; color?: string }>; message?: string;
  localProof?: import('../local-question-bank/library-types').LocalAnswerProof;
}
export interface QuestionIdentity { documentKey: string; scopeKey: string; key: string; fingerprint: string }
export interface PaperFlowInfo {
  attemptKey: string; pageKey: string; page: number; total?: number; canNext: boolean; terminal: boolean; canSave: boolean; reason: string;
}
export type AnswerPageCommand =
  | { action: 'inspect' }
  | ({ action: 'read' | 'images' } & QuestionIdentity)
  | ({ action: 'write'; expectedVersion: string; answer: ApplicableAnswer; replace: boolean } & QuestionIdentity)
  | { action: 'flow'; operation: 'inspect' | 'save' | 'next'; documentKey: string; scopeKey: string; attemptKey?: string; pageKey?: string;
      expected?: Array<{ key: string; fingerprint: string; version: string }> }
  | { action: 'finish'; documentKey: string; scopeKey: string; policy: 'save' | 'submit';
      expected: Array<{ key: string; fingerprint: string; version: string }> }
  | { action: 'cancel' };
export interface AnswerPageResult {
  ok: boolean; error?: string; warning?: string; snapshot?: QuestionPageSnapshot; control?: AnswerControlSnapshot;
  prepared?: PreparedQuestion; outcome?: 'saved' | 'submitted';
  flow?: PaperFlowInfo;
}
export type AnswerRowPhase = 'pending' | 'querying' | 'searched' | 'filled' | 'existing' | 'unsupported' | 'error' | 'needs-review';
export interface AnswerRow {
  id: string; target: QuestionTarget; phase: AnswerRowPhase; message: string; text: string;
  source?: AnswerSource; tags?: AnswerResult['tags'];
  /** Completed provider result, retained independently of page edits or a failed write. */
  resultAnswer?: ApplicableAnswer;
  resultApplicable?: boolean;
  currentAnswer?: ApplicableAnswer; readOnly?: boolean;
  review?: {
    status: 'suspect' | 'uncertain';
    suggestedAnswer?: ApplicableAnswer;
    reason: string;
  };
}
export interface AnswerPaper {
  id: string; frameId: number; documentId?: string; documentKey: string; scopeKey: string;
  scene: QuestionPageSnapshot['scene']; allLoaded: boolean; complete: boolean; rowIds: string[];
}
export interface QuestionAnswerState {
  phase: 'idle' | 'scanning' | 'running' | 'paused' | 'complete' | 'error'; running: boolean;
  source: AnswerSourceMode | null; rows: AnswerRow[]; message: string;
  mode?: AnswerMode; range?: AnswerRange;
  history?: { available: number; busy: boolean; message: string };
  sources?: AnswerSourcesStatus; sourcesError?: string; sourceSaving?: boolean;
  selectedId?: string; activeId?: string; followProgress?: boolean;
  previewing?: boolean; previewStale?: boolean; papers?: AnswerPaper[];
  completion?: 'saving' | 'submitting' | 'saved' | 'submitted' | 'unconfirmed';
  reviewing?: boolean; reviewProgress?: string; reviewError?: string; reviewAvailable?: boolean;
}
export interface QuestionAnswerController {
  flow?: import('./flow-controller').PaperFlowController;
  getState(): QuestionAnswerState;
  subscribe(listener: (state: QuestionAnswerState) => void): () => void;
  start(): void; stop(): void; retry(id: string, replace?: boolean): void; setSource(source: AnswerSourceMode): void;
  refreshSources(): void; settingsChanged(): void; dispose(): void;
  preview?(): void; selectQuestion?(id: string): void; followProgress?(): void;
  reviewAnswers?(force?: boolean): void;
  setMode?(mode: AnswerMode): void; setRange?(range: AnswerRange): void;
  search?(id: string): void; applyResult?(id: string, replace?: boolean): void;
  restoreHistory?(): void; clearHistory?(): void;
  applyImportedAnswers?(entries: ImportedAnswer[], source?: 'import' | 'local-bank'): Promise<void>;
}
export const ANSWER_FRAME_PORT = 'toolbox:question-answer:frames:v1';
export const ANSWER_GENERATION_PORT = 'toolbox:question-answer:generate:v1';
