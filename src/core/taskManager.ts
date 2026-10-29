// Owns tasks, routing of utterances, follow-ups, cancellation and the transcript.
// Independent of Electron so it can be tested with the demo adapter.

import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentEvent,
  AgentId,
  ApprovalDecision,
  CancelResult,
  FollowUp,
  FollowUpKind,
  PendingQuestion,
  Settings,
  TaskInfo,
  TaskState,
  TranscriptEntry,
  UiEvent,
} from '../shared/types';
import { TERMINAL_STATES } from '../shared/types';
import { Acknowledger, framedFollowUp, type AckReason } from './acknowledger';
import { buildReport, emptyEvidence, parseSelfReport, recordEvidence, stripOutcomeLine } from './evidence';
import { routeUtterance, type AskChoice } from './intentRouter';
import { planSpeech, SentenceStream } from './speechShaper';
import type { TranscriptStore } from './transcriptStore';

export interface TaskManagerOptions {
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  emit: (e: UiEvent) => void;
  store?: TranscriptStore | null;
  settings: () => Settings;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
  /** How long to wait for an agent to confirm a cancellation. */
  cancelTimeoutMs?: number;
}

interface PendingAsk {
  question: PendingQuestion;
  text: string;
}

interface Live {
  textEntryId: string | null;
  sentences: SentenceStream;
  spokenSentences: number;
  usedTools: boolean;
  cancelWatch?: ReturnType<typeof setTimeout>;
}

const MAX_STREAMED_SENTENCES = 4;

export class TaskManager {
  readonly tasks = new Map<string, TaskInfo>();
  readonly entries: TranscriptEntry[] = [];
  private live = new Map<string, Live>();
  private pending: PendingAsk | null = null;
  private ack: Acknowledger;
  private lastAgentUsed: AgentId | null = null;
  private now: () => number;

  constructor(private o: TaskManagerOptions) {
    this.now = o.now ?? Date.now;
    this.ack = new Acknowledger(6000, this.now);
  }

  // ---------- queries ----------

  get activeTask(): TaskInfo | undefined {
    return [...this.tasks.values()].find((t) => ['running', 'awaiting_input', 'updating'].includes(t.state));
  }

  get pendingQuestion(): PendingQuestion | undefined {
    return this.pending?.question;
  }

  private adapterFor(id: AgentId): AgentAdapter {
    const a = this.o.adapters[id];
    if (!a) throw new Error(`Agent "${id}" is not available.`);
    return a;
  }

  // ---------- restoring a conversation ----------

  restore(entries: TranscriptEntry[], tasks: TaskInfo[]): void {
    this.entries.push(...entries);
    for (const t of tasks) {
      if (!TERMINAL_STATES.includes(t.state)) {
        t.state = 'failed';
        t.error = 'Interrupted: the app closed while this task was running.';
        t.finishedAt = this.now();
        this.persistTask(t);
        this.addEntry({ type: 'system', id: randomUUID(), at: this.now(), level: 'warn', text: `Task "${t.title}" was interrupted when the app closed. Ask again to resume it.` });
      }
      this.tasks.set(t.id, t);
      this.lastAgentUsed = t.agentId;
    }
  }

  // ---------- user input ----------

  async submit(rawText: string, via: 'voice' | 'keyboard'): Promise<void> {
    const text = rawText.trim();
    if (!text) return;

    if (this.pending) {
      const choice = this.matchSpokenChoice(text, this.pending.question);
      if (choice) {
        this.addEntry({ type: 'user', id: randomUUID(), at: this.now(), text, via, intent: `answer:${choice}` });
        return this.answerQuestion(this.pending.question.id, choice);
      }
      this.clearQuestion();
    }

    const active = this.activeTask;
    const approvalWord = text.match(/^(approve|allow|yes|deny|reject|no)[.!]?$/i)?.[1].toLowerCase();
    if (active?.state === 'awaiting_input' && approvalWord) {
      this.addEntry({ type: 'user', id: randomUUID(), at: this.now(), text, via });
      if (via === 'voice' && !this.o.settings().voiceApprovals) {
        this.say('Approvals need a click or the keyboard: press A to approve or D to deny.', 'alert');
        return;
      }
      const pendingApproval = active.evidence.approvals.find((a) => !a.decision);
      if (pendingApproval) this.approve(pendingApproval.id, ['approve', 'allow', 'yes'].includes(approvalWord) ? 'allow' : 'deny');
      return;
    }

    const intent = routeUtterance(text, {
      hasActiveTask: !!active,
      hasFinishedTask: [...this.tasks.values()].some((t) => TERMINAL_STATES.includes(t.state)),
    });
    const userEntry: TranscriptEntry = { type: 'user', id: randomUUID(), at: this.now(), text, via, intent: intent.kind, taskId: active?.id };
    this.addEntry(userEntry);

    switch (intent.kind) {
      case 'new':
        return this.createTask(text);
      case 'detail':
        return this.createTask(
          `Follow-up question about the work you just did. Answer from what you already know and have done; do not rerun commands or tests unless the question requires it.\n\n${text}`,
          text,
        );
      case 'add':
      case 'clarify':
      case 'prioritise':
        return this.followUp(active!, intent.kind, text);
      case 'separate':
        return this.createTask(text);
      case 'stop':
        await this.cancel(active!.id);
        return;
      case 'status':
        return this.reportStatus();
      case 'ask': {
        if (!intent.options.length) {
          this.say(intent.question, 'alert');
          return;
        }
        const q: PendingQuestion = { id: randomUUID(), question: intent.question, options: intent.options };
        this.pending = { question: q, text };
        this.o.emit({ type: 'question', question: q });
        this.addEntry({ type: 'assistant', id: randomUUID(), at: this.now(), text: intent.question, spoken: true });
        this.say(intent.question, 'alert');
      }
    }
  }

  private matchSpokenChoice(text: string, q: PendingQuestion): AskChoice | null {
    const s = text.toLowerCase();
    const has = (v: string) => q.options.some((o) => o.value === v);
    if (/\b(?:instead|replace)\b/.test(s) && has('replace')) return 'replace';
    if (/\b(?:cancel|stop|abort)\b/.test(s) && has('stop')) return 'stop';
    if (/\b(?:separate|queue|new task|later|after)\b/.test(s) && has('separate')) return 'separate';
    if (/\b(?:add|include|current|pass it on|instruction|yes)\b/.test(s) && has('add')) return 'add';
    return null;
  }

  async answerQuestion(id: string, value: string): Promise<void> {
    if (!this.pending || this.pending.question.id !== id) return;
    const { text } = this.pending;
    this.clearQuestion();
    const active = this.activeTask;
    switch (value as AskChoice) {
      case 'add':
      case 'clarify':
        if (active) return this.followUp(active, value as FollowUpKind, text);
        return this.createTask(text);
      case 'separate':
        return this.createTask(text);
      case 'stop':
        if (active) await this.cancel(active.id);
        return;
      case 'replace':
        if (active) await this.cancel(active.id);
        return this.createTask(text);
    }
  }

  private clearQuestion(): void {
    this.pending = null;
    this.o.emit({ type: 'question', question: null });
  }

  // ---------- tasks ----------

  private createTask(prompt: string, displayPrompt = prompt): void {
    const settings = this.o.settings();
    const task: TaskInfo = {
      id: randomUUID(),
      title: displayPrompt.length > 70 ? `${displayPrompt.slice(0, 67)}…` : displayPrompt,
      prompt,
      agentId: settings.agentId,
      state: 'queued',
      priority: 0,
      followUps: [],
      evidence: emptyEvidence(),
      createdAt: this.now(),
    };
    this.tasks.set(task.id, task);
    this.persistTask(task);
    if (this.activeTask) this.speakAck('task_queued');
    this.pump();
  }

  private pump(): void {
    if (this.activeTask) return;
    const next = [...this.tasks.values()]
      .filter((t) => t.state === 'queued')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
    if (next) void this.run(next);
  }

  private async run(task: TaskInfo): Promise<void> {
    let adapter: AgentAdapter;
    try {
      adapter = this.adapterFor(task.agentId);
    } catch (err) {
      return this.finish(task, 'error', undefined, (err as Error).message);
    }
    const settings = this.o.settings();
    const handoff = this.lastAgentUsed && this.lastAgentUsed !== task.agentId ? this.buildHandoff() : undefined;
    this.lastAgentUsed = task.agentId;
    this.setState(task, 'running');
    task.startedAt = this.now();
    this.live.set(task.id, { textEntryId: null, sentences: new SentenceStream(), spokenSentences: 0, usedTools: false });
    if (!task.prompt.startsWith('Follow-up question about the work')) this.speakAck('task_started');

    try {
      await adapter.start({ taskId: task.id, prompt: task.prompt, cwd: settings.cwd || process.cwd(), handoff }, (id, e) => this.onAgentEvent(id, e));
    } catch (err) {
      this.o.log?.('error', `Adapter ${task.agentId} crashed: ${(err as Error).stack ?? err}`);
      if (!TERMINAL_STATES.includes(task.state)) this.finish(task, 'error', undefined, `The ${adapter.label} adapter failed: ${(err as Error).message}`);
    }
    // An adapter that returns without a terminal event has failed silently.
    if (!TERMINAL_STATES.includes(task.state)) this.finish(task, 'error', undefined, `${adapter.label} stopped without reporting a result.`);
  }

  private onAgentEvent(taskId: string, e: AgentEvent): void {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_STATES.includes(task.state)) return;
    const live = this.live.get(taskId)!;
    recordEvidence(task.evidence, e);

    switch (e.kind) {
      case 'text': {
        if (e.delta) {
          if (!live.textEntryId) {
            live.textEntryId = randomUUID();
            this.addEntry({ type: 'agent_text', id: live.textEntryId, at: this.now(), taskId, agentId: task.agentId, text: '' }, false);
          }
          const entry = this.entries.find((x) => x.id === live.textEntryId) as Extract<TranscriptEntry, { type: 'agent_text' }>;
          entry.text += e.text;
          this.o.emit({ type: 'agent_delta', entryId: entry.id, taskId, text: e.text });
          this.streamSpeech(live, e.text);
        } else {
          if (live.textEntryId) {
            const entry = this.entries.find((x) => x.id === live.textEntryId) as Extract<TranscriptEntry, { type: 'agent_text' }>;
            entry.text = e.text;
            this.updateEntry(entry.id, { text: e.text });
            live.textEntryId = null;
          } else {
            this.addEntry({ type: 'agent_text', id: randomUUID(), at: this.now(), taskId, agentId: task.agentId, text: e.text });
            this.streamSpeech(live, `${e.text}\n\n`);
          }
          task.finalText = e.text;
        }
        break;
      }
      case 'tool_call':
        this.closeText(live);
        live.usedTools = true;
        this.addEntry({ type: 'tool', id: e.id, at: this.now(), taskId, tool: e.tool, summary: e.summary });
        break;
      case 'tool_result':
        this.updateEntry(e.id, { ok: e.ok, output: e.output?.slice(0, 20000) });
        break;
      case 'command': {
        const existing = this.entries.find((x) => x.id === `cmd-${e.id}`);
        if (existing) this.updateEntry(existing.id, { exitCode: e.exitCode, output: e.output?.slice(0, 20000) });
        else this.addEntry({ type: 'command', id: `cmd-${e.id}`, at: this.now(), taskId, command: e.command, exitCode: e.exitCode, output: e.output?.slice(0, 20000) });
        const rec = task.evidence.commands.find((c) => c.id === e.id);
        if (rec?.isTest && e.exitCode !== undefined && e.exitCode !== 0) this.speakAck('test_failed');
        break;
      }
      case 'approval_request':
        this.closeText(live);
        this.setState(task, 'awaiting_input');
        this.addEntry({ type: 'approval', id: e.approvalId, at: this.now(), taskId, tool: e.tool, description: e.description, detail: e.detail });
        this.speakAck('approval_needed');
        break;
      case 'approval_resolved':
        this.updateEntry(e.approvalId, { decision: e.decision });
        if (task.state === 'awaiting_input') this.setState(task, 'running');
        break;
      case 'followup_status': {
        const f = task.followUps.find((x) => x.id === e.followUpId);
        if (!f || f.status === e.status) break;
        f.status = e.status;
        if (e.note) f.note = e.note;
        if (e.status === 'accepted') this.speakAck('followup_accepted');
        if (e.status === 'rejected') this.speakAck('followup_rejected');
        if (task.state === 'updating' && e.status !== 'queued') this.setState(task, 'running');
        else this.persistTask(task);
        break;
      }
      case 'status':
        break;
      case 'error':
        this.addEntry({ type: 'system', id: randomUUID(), at: this.now(), level: e.recoverable ? 'warn' : 'error', text: e.message });
        if (!e.recoverable) this.speakAck('agent_error');
        break;
      case 'session':
      case 'thinking':
      case 'file_change':
        break;
      case 'done':
        this.closeText(live);
        if (e.finalText) task.finalText = e.finalText;
        if (task.finalText) task.selfReport = parseSelfReport(task.finalText);
        this.finish(task, e.outcome, live, e.error);
        break;
    }
  }

  private streamSpeech(live: Live, delta: string): void {
    // Speech streams only for conversational answers; work tasks get a summary at the end.
    if (live.usedTools || !this.o.settings().speak) {
      live.sentences.push(delta);
      return;
    }
    for (const s of live.sentences.push(delta)) {
      if (live.spokenSentences >= MAX_STREAMED_SENTENCES) break;
      live.spokenSentences++;
      this.say(s, 'summary');
    }
  }

  private closeText(live: Live): void {
    if (!live.textEntryId) return;
    const entry = this.entries.find((x) => x.id === live.textEntryId) as Extract<TranscriptEntry, { type: 'agent_text' }> | undefined;
    if (entry) this.updateEntry(entry.id, { text: entry.text });
    live.textEntryId = null;
  }

  private finish(task: TaskInfo, outcome: 'success' | 'error' | 'cancelled', live?: Live, error?: string): void {
    if (live?.cancelWatch) clearTimeout(live.cancelWatch);
    task.finishedAt = this.now();
    if (error) task.error = error;
    const state: TaskState = outcome === 'cancelled' ? 'cancelled' : outcome === 'error' ? 'failed' : 'completed';
    task.state = state;

    const conversational = !live?.usedTools && !task.evidence.files.length && outcome === 'success';
    if (conversational) {
      // Speak whatever the stream didn't already cover.
      if (live && live.spokenSentences < MAX_STREAMED_SENTENCES)
        for (const s of live.sentences.flush().slice(0, MAX_STREAMED_SENTENCES - live.spokenSentences)) this.say(s, 'summary');
    } else {
      const report = buildReport(task);
      task.report = report;
      if (report.outcome === 'partial') task.state = 'partial';
      this.addEntry({ type: 'report', id: randomUUID(), at: this.now(), taskId: task.id, report });
      const agentLead = outcome === 'success' && task.finalText ? planSpeech(stripOutcomeLine(task.finalText), 1, 200).sentences.join(' ') : '';
      this.say([report.spoken, agentLead].filter(Boolean).join(' '), 'summary');
      if (outcome === 'cancelled') this.speakAck('cancelled');
    }
    if (outcome === 'error' && error) this.addEntry({ type: 'system', id: randomUUID(), at: this.now(), level: 'error', text: error });

    this.persistTask(task);
    this.live.delete(task.id);

    // Instructions the agent couldn't take mid-task run next, ahead of other queued work.
    const held = task.followUps.filter((f) => f.status === 'pending');
    if (held.length && outcome !== 'cancelled') {
      this.createContinuation(task, held);
    }
    this.pump();
  }

  private createContinuation(parent: TaskInfo, held: FollowUp[]): void {
    const text = held.map((f) => `- (${f.kind}) ${f.text}`).join('\n');
    const prompt = `Continuing the previous task ("${parent.title}"). While you were working, the user added these instructions, which could not be delivered mid-task. Apply them now:\n${text}`;
    for (const f of held) {
      f.status = 'queued';
      f.note = 'Sent as a follow-up turn after the task finished.';
    }
    this.persistTask(parent);
    const t: TaskInfo = {
      id: randomUUID(),
      title: `Follow-up: ${held[0].text.slice(0, 60)}`,
      prompt,
      agentId: parent.agentId,
      state: 'queued',
      priority: Math.max(0, ...[...this.tasks.values()].map((x) => x.priority)) + 1,
      followUps: [],
      evidence: emptyEvidence(),
      createdAt: this.now(),
    };
    this.tasks.set(t.id, t);
    this.persistTask(t);
  }

  private async followUp(task: TaskInfo, kind: FollowUpKind, text: string): Promise<void> {
    const adapter = this.adapterFor(task.agentId);
    const f: FollowUp = { id: randomUUID(), text, kind, status: 'pending', at: this.now() };
    task.followUps.push(f);

    if (adapter.capabilities.midTaskInput === 'none') {
      f.note = 'This agent cannot take instructions mid-task. It will be sent as soon as the current task finishes.';
      this.persistTask(task);
      this.speakAck('followup_queued');
      return;
    }

    this.setState(task, 'updating');
    try {
      const receipt = await adapter.sendFollowUp(task.id, f.id, framedFollowUp(kind, text));
      // The agent may already have confirmed via an event while we awaited.
      if (f.status === 'pending' || receipt.status === 'accepted' || receipt.status === 'rejected') f.status = receipt.status;
      f.note = receipt.note;
      if (receipt.status === 'pending') {
        this.speakAck('followup_queued');
      } else if (receipt.status === 'queued') {
        this.speakAck(adapter.capabilities.midTaskInput === 'between-steps' ? 'followup_sent' : 'followup_queued');
      } else if (receipt.status === 'accepted') {
        this.speakAck('followup_accepted');
      } else {
        this.speakAck('followup_rejected');
      }
    } catch (err) {
      f.status = 'rejected';
      f.note = `Could not deliver: ${(err as Error).message}`;
      this.speakAck('followup_rejected');
    }
    if (task.state === 'updating') this.setState(task, 'running');
    else this.persistTask(task);
  }

  async cancel(taskId: string): Promise<CancelResult> {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, note: 'No such task.' };
    if (TERMINAL_STATES.includes(task.state)) return { ok: false, note: `Task already ${task.state}.` };
    if (task.state === 'queued') {
      task.state = 'cancelled';
      task.finishedAt = this.now();
      this.persistTask(task);
      this.say('Removed that task from the queue.', 'ack');
      return { ok: true, note: 'Removed from the queue before it started.' };
    }

    this.speakAck('cancel_requested');
    const adapter = this.adapterFor(task.agentId);
    let result: CancelResult;
    try {
      result = await adapter.interrupt(taskId);
    } catch (err) {
      result = { ok: false, note: (err as Error).message };
    }
    const live = this.live.get(taskId);
    if (!result.ok) {
      this.addEntry({ type: 'system', id: randomUUID(), at: this.now(), level: 'error', text: `Cancel request failed: ${result.note}` });
      this.speakAck('cancel_failed');
    } else if (live && !TERMINAL_STATES.includes(task.state)) {
      // Interrupt was accepted; the agent's terminal event confirms it. Watch for one that never comes.
      live.cancelWatch = setTimeout(() => {
        if (!TERMINAL_STATES.includes(task.state)) {
          this.addEntry({ type: 'system', id: randomUUID(), at: this.now(), level: 'warn', text: `${adapter.label} accepted the cancel request but hasn't confirmed it stopped.` });
          this.speakAck('cancel_failed');
        }
      }, this.o.cancelTimeoutMs ?? 15000);
    }
    return result;
  }

  setPriority(taskId: string, priority: number): void {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== 'queued') return;
    t.priority = priority;
    this.persistTask(t);
    this.speakAck('priority_changed');
  }

  approve(approvalId: string, decision: ApprovalDecision): void {
    const task = [...this.tasks.values()].find((t) => t.evidence.approvals.some((a) => a.id === approvalId && !a.decision));
    if (!task) return;
    this.adapterFor(task.agentId).respondToApproval(approvalId, decision);
    this.onAgentEvent(task.id, { kind: 'approval_resolved', approvalId, decision });
  }

  agentSwitched(agentId: AgentId): void {
    this.addEntry({ type: 'system', id: randomUUID(), at: this.now(), level: 'info', text: `Switched to ${this.o.adapters[agentId]?.label ?? agentId}. New tasks go to this agent; the transcript is kept.` });
    this.speakAck('switched_agent');
  }

  private reportStatus(): void {
    const active = this.activeTask;
    const queued = [...this.tasks.values()].filter((t) => t.state === 'queued').length;
    let text: string;
    if (!active) text = queued ? `Nothing is running. ${queued} task${queued === 1 ? ' is' : 's are'} queued.` : 'Nothing is running right now.';
    else {
      const mins = Math.round((this.now() - (active.startedAt ?? this.now())) / 60000);
      const lastTool = [...this.entries].reverse().find((e) => e.type === 'tool' && e.taskId === active.id) as Extract<TranscriptEntry, { type: 'tool' }> | undefined;
      const stateText = { running: 'working on', awaiting_input: 'waiting for your approval on', updating: 'taking your follow-up for' }[active.state as 'running'] ?? active.state;
      text = `I'm ${stateText} "${active.title}"${mins ? `, for about ${mins} minute${mins === 1 ? '' : 's'}` : ''}.`;
      if (lastTool) text += ` Latest step: ${lastTool.summary}.`;
      const f = active.followUps;
      if (f.length) text += ` ${f.filter((x) => x.status === 'accepted').length} of ${f.length} follow-ups confirmed.`;
      if (queued) text += ` ${queued} more queued.`;
    }
    this.addEntry({ type: 'assistant', id: randomUUID(), at: this.now(), text, spoken: true });
    this.say(text, 'alert');
  }

  private buildHandoff(): string {
    const lines: string[] = [];
    for (const e of this.entries.slice(-40)) {
      if (e.type === 'user') lines.push(`User: ${e.text}`);
      else if (e.type === 'agent_text') lines.push(`${e.agentId} agent: ${e.text.slice(0, 600)}`);
      else if (e.type === 'report') lines.push(`Result: ${e.report.markdown.slice(0, 800)}`);
    }
    let s = lines.join('\n');
    if (s.length > 6000) s = `…${s.slice(-6000)}`;
    return `The user switched to you from another coding agent. Conversation so far, for context:\n${s}`;
  }

  // ---------- plumbing ----------

  private speakAck(reason: AckReason): void {
    const line = this.ack.pick(reason);
    if (!line) return;
    this.addEntry({ type: 'assistant', id: randomUUID(), at: this.now(), text: line, spoken: true });
    this.say(line, reason === 'approval_needed' || reason.startsWith('cancel') ? 'alert' : 'ack');
  }

  private say(text: string, priority: 'ack' | 'summary' | 'alert'): void {
    if (!text.trim()) return;
    this.o.emit({ type: 'say', text, priority });
  }

  private setState(task: TaskInfo, state: TaskState): void {
    if (task.state === state) return;
    task.state = state;
    this.persistTask(task);
  }

  private persistTask(task: TaskInfo): void {
    this.o.store?.append({ type: 'task', id: `task-${task.id}`, at: this.now(), task: structuredClone(task) });
    this.o.emit({ type: 'task', task: structuredClone(task) });
  }

  private addEntry(entry: TranscriptEntry, persist = true): void {
    this.entries.push(entry);
    if (persist) this.o.store?.append(entry);
    this.o.emit({ type: 'entry', entry });
  }

  private updateEntry(id: string, patch: Record<string, unknown>): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    this.o.store?.append(e);
    this.o.emit({ type: 'entry_update', id, patch: patch as Partial<TranscriptEntry> });
  }

  async shutdown(): Promise<void> {
    const active = this.activeTask;
    if (active) {
      try {
        await this.adapterFor(active.agentId).interrupt(active.id);
      } catch {
        /* shutting down anyway */
      }
    }
    for (const a of Object.values(this.o.adapters)) await a?.dispose().catch(() => undefined);
    this.o.store?.close();
  }
}
