// Types shared by the main process, the renderer and the adapters.

export type AgentId = 'claude' | 'codex' | 'demo';

export type TaskState =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'updating'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STATES: readonly TaskState[] = ['completed', 'partial', 'failed', 'cancelled'];

export type FollowUpStatus =
  /** Recorded by the app, not yet handed to the agent. */
  | 'pending'
  /** Handed to the agent, which has not yet confirmed reading it. */
  | 'queued'
  /** The agent confirmed it read the instruction (e.g. a reply stamped with its id). */
  | 'accepted'
  | 'rejected';

export type FollowUpKind = 'add' | 'clarify' | 'prioritise';

export interface FollowUp {
  id: string;
  text: string;
  kind: FollowUpKind;
  status: FollowUpStatus;
  note?: string;
  at: number;
}

export interface CommandRecord {
  id: string;
  command: string;
  exitCode?: number;
  output?: string;
  isTest: boolean;
  tests?: { passed: number; failed: number; skipped: number };
}

export interface FileChange {
  path: string;
  change: 'edit' | 'create' | 'delete';
}

export interface ApprovalRecord {
  id: string;
  tool: string;
  description: string;
  decision?: 'allow' | 'deny';
}

export interface Evidence {
  files: FileChange[];
  commands: CommandRecord[];
  approvals: ApprovalRecord[];
}

export interface TaskInfo {
  id: string;
  title: string;
  prompt: string;
  agentId: AgentId;
  state: TaskState;
  priority: number;
  followUps: FollowUp[];
  evidence: Evidence;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  finalText?: string;
  /** Parsed from the agent's final message, when it gave one. */
  selfReport?: SelfReport;
  error?: string;
  report?: CompletionReport;
}

export interface CompletionReport {
  outcome: 'completed' | 'partial' | 'failed' | 'cancelled';
  asked: string;
  changed: string[];
  why: string;
  checks: string[];
  passed: string[];
  failed: string[];
  issues: string[];
  needsApproval: string[];
  markdown: string;
  spoken: string;
}

/** Normalised events emitted by an agent adapter. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string; delta?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; tool: string; summary: string; input?: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean; output?: string }
  | { kind: 'command'; id: string; command: string; exitCode?: number; output?: string }
  | { kind: 'file_change'; path: string; change: FileChange['change'] }
  | { kind: 'approval_request'; approvalId: string; tool: string; description: string; detail?: string }
  | { kind: 'approval_resolved'; approvalId: string; decision: 'allow' | 'deny' }
  | { kind: 'followup_status'; followUpId: string; status: FollowUpStatus; note?: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; message: string; recoverable: boolean }
  | { kind: 'done'; outcome: 'success' | 'error' | 'cancelled'; finalText?: string; error?: string };

/** The agent's own statement of whether it finished, from an explicit `Outcome:` line. */
export interface SelfReport {
  status: 'complete' | 'partial' | 'blocked';
  note?: string;
}

export type AgentEventSink = (taskId: string, event: AgentEvent) => void;

export interface AgentCapabilities {
  /** How instructions sent while a task runs are delivered. */
  midTaskInput: 'between-steps' | 'next-turn' | 'none';
  interrupt: boolean;
  approvals: boolean;
  resume: boolean;
}

export interface HealthReport {
  ok: boolean;
  installed: boolean;
  authenticated?: boolean;
  version?: string;
  detail: string;
  fix?: string;
}

export interface FollowUpReceipt {
  status: FollowUpStatus;
  note: string;
}

export interface CancelResult {
  ok: boolean;
  note: string;
}

export type ApprovalDecision = 'allow' | 'deny';

export interface StartTaskInput {
  taskId: string;
  prompt: string;
  cwd: string;
  /** Prior conversation, handed over when switching agents. */
  handoff?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  readonly capabilities: AgentCapabilities;
  check(): Promise<HealthReport>;
  /** Runs a task. Events go to the sink; resolves after the terminal `done` event. */
  start(input: StartTaskInput, sink: AgentEventSink): Promise<void>;
  sendFollowUp(taskId: string, followUpId: string, text: string): Promise<FollowUpReceipt>;
  interrupt(taskId: string): Promise<CancelResult>;
  respondToApproval(approvalId: string, decision: ApprovalDecision): void;
  dispose(): Promise<void>;
}

// ---------- conversation transcript ----------

export type TranscriptEntry =
  | { type: 'user'; id: string; at: number; text: string; via: 'voice' | 'keyboard'; intent?: string; taskId?: string }
  | { type: 'agent_text'; id: string; at: number; taskId: string; agentId: AgentId; text: string }
  | { type: 'tool'; id: string; at: number; taskId: string; tool: string; summary: string; ok?: boolean; output?: string }
  | { type: 'command'; id: string; at: number; taskId: string; command: string; exitCode?: number; output?: string }
  | { type: 'approval'; id: string; at: number; taskId: string; tool: string; description: string; detail?: string; decision?: ApprovalDecision }
  | { type: 'assistant'; id: string; at: number; text: string; spoken: boolean }
  | { type: 'system'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'report'; id: string; at: number; taskId: string; report: CompletionReport }
  | { type: 'task'; id: string; at: number; task: TaskInfo };

// ---------- IPC between main and renderer ----------

export type CredentialName = 'openai';

export interface AppSnapshot {
  agentId: AgentId;
  cwd: string;
  tasks: TaskInfo[];
  transcript: TranscriptEntry[];
  health: Partial<Record<AgentId, HealthReport>>;
  settings: Settings;
  pendingQuestion?: PendingQuestion;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options: { label: string; value: string }[];
}

export interface Settings {
  agentId: AgentId;
  cwd: string;
  speak: boolean;
  voice: string;
  ttsEngine: 'kokoro' | 'system' | 'openai';
  sttEngine: 'local' | 'openai';
  /** On-device recogniser: Moonshine is fastest for short instructions. */
  sttModel: 'moonshine-base' | 'whisper-base' | 'whisper-tiny';
  rate: number;
  volume: number;
  style: 'brief' | 'normal' | 'detailed';
  listenMode: 'push-to-talk' | 'continuous';
  /** Silence (ms) after which a turn may end. */
  endOfTurnMs: number;
  /** Extra wait when the utterance looks unfinished. */
  hesitationExtraMs: number;
  /** Time a finished voice transcript stays editable before it is sent. */
  reviewWindowMs: number;
  voiceApprovals: boolean;
  firstRunDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  agentId: 'demo',
  cwd: '',
  speak: true,
  voice: '',
  ttsEngine: 'system',
  sttEngine: 'local',
  sttModel: 'moonshine-base',
  rate: 1,
  volume: 0.9,
  style: 'normal',
  listenMode: 'push-to-talk',
  endOfTurnMs: 1600,
  hesitationExtraMs: 1600,
  reviewWindowMs: 1500,
  voiceApprovals: false,
  firstRunDone: false,
};

/** Pushed from main to renderer. */
export type UiEvent =
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'entry_update'; id: string; patch: Partial<TranscriptEntry> }
  | { type: 'agent_delta'; entryId: string; taskId: string; text: string }
  | { type: 'task'; task: TaskInfo }
  | { type: 'say'; text: string; priority: 'ack' | 'summary' | 'alert' }
  | { type: 'question'; question: PendingQuestion | null }
  | { type: 'health'; agentId: AgentId; report: HealthReport }
  | { type: 'model_progress'; id: string; file: string; fileIndex: number; fileCount: number; received: number; total: number };

export interface ModelStatus {
  id: string;
  label: string;
  approxMB: number;
  purpose: string;
  installed: boolean;
}

/** Renderer → main requests. */
export interface Api {
  snapshot(): Promise<AppSnapshot>;
  submit(text: string, via: 'voice' | 'keyboard'): Promise<void>;
  answerQuestion(id: string, value: string): Promise<void>;
  cancelTask(taskId: string): Promise<CancelResult>;
  setPriority(taskId: string, priority: number): Promise<void>;
  approve(approvalId: string, decision: ApprovalDecision): Promise<void>;
  switchAgent(agentId: AgentId): Promise<void>;
  checkHealth(): Promise<Partial<Record<AgentId, HealthReport>>>;
  chooseFolder(): Promise<string | null>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  newConversation(): Promise<void>;
  /** Stores a cloud speech key in the OS keystore. The key is never sent back to the renderer. */
  setCredential(name: CredentialName, value: string | null): Promise<{ ok: boolean; error?: string }>;
  credentialStatus(): Promise<Record<CredentialName, boolean> & { secureStorage: boolean }>;
  /** Cloud speech calls are made by the main process so keys never reach the page. */
  cloudTts(text: string, voice: string, speed: number): Promise<ArrayBuffer>;
  cloudStt(audio: ArrayBuffer, mime: string): Promise<string>;
  /** On-device recognition in the speech utility process (audio stays on this computer). */
  transcribe(audio: Float32Array): Promise<{ text: string; ms: number }>;
  preloadSpeech(): Promise<{ ok: boolean; error?: string }>;
  /** On-device natural voice (Kokoro) in the speech utility process. */
  synthesize(text: string, voice: string, speed: number): Promise<{ samples: Float32Array; rate: number; ms: number }>;
  modelStatus(): Promise<ModelStatus[]>;
  downloadModels(ids: string[]): Promise<{ ok: boolean; error?: string }>;
  systemInfo(): Promise<{ platform: string; arch: string; cpus: number; cpuModel: string; memGB: number; electron: string }>;
  logRenderer(level: 'info' | 'warn' | 'error', message: string): void;
  onEvent(cb: (e: UiEvent) => void): () => void;
}
