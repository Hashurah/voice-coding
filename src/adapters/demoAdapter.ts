// Scripted agent for demo mode and tests. No network, no file access.
// It follows the same contract as the real adapters: follow-ups are confirmed
// only when a step boundary actually picks them up, and cancellation is
// confirmed by a terminal event.

import type {
  AgentAdapter,
  AgentEventSink,
  ApprovalDecision,
  CancelResult,
  FollowUpReceipt,
  HealthReport,
  StartTaskInput,
} from '../shared/types';

interface Run {
  taskId: string;
  sink: AgentEventSink;
  inbox: { id: string; text: string }[];
  cancelled: boolean;
  approvals: Map<string, (d: ApprovalDecision) => void>;
}

export interface DemoOptions {
  /** Multiplier on all delays; tests use a small value. */
  speed?: number;
  /** Require approval before the demo "edits" a file. */
  askApproval?: boolean;
  /** Make the first test run fail, then pass after the fix. */
  failFirstTest?: boolean;
}

export class DemoAdapter implements AgentAdapter {
  readonly id = 'demo' as const;
  readonly label = 'Demo agent';
  readonly capabilities = { midTaskInput: 'between-steps', interrupt: true, approvals: true, resume: false } as const;
  private runs = new Map<string, Run>();
  private approvalOwner = new Map<string, Run>();
  private seq = 0;

  constructor(private opts: DemoOptions = {}) {}

  async check(): Promise<HealthReport> {
    return { ok: true, installed: true, authenticated: true, version: 'built-in', detail: 'Scripted demo agent. Makes no changes and uses no network.' };
  }

  private wait(ms: number, run: Run): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms * (this.opts.speed ?? 1));
      if (run.cancelled) {
        clearTimeout(t);
        resolve();
      }
    });
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  /** A step boundary: pick up any follow-ups that arrived during the last step. */
  private drainInbox(run: Run): string[] {
    const taken = run.inbox.splice(0);
    for (const f of taken) run.sink(run.taskId, { kind: 'followup_status', followUpId: f.id, status: 'accepted', note: 'Picked up at the next step.' });
    return taken.map((f) => f.text);
  }

  async start(input: StartTaskInput, sink: AgentEventSink): Promise<void> {
    const run: Run = { taskId: input.taskId, sink, inbox: [], cancelled: false, approvals: new Map() };
    this.runs.set(input.taskId, run);
    const emit = (e: Parameters<AgentEventSink>[1]) => sink(input.taskId, e);
    const extra: string[] = [];
    const cancelled = () => {
      if (!run.cancelled) return false;
      emit({ kind: 'done', outcome: 'cancelled', finalText: 'Stopped at your request.' });
      return true;
    };

    try {
      emit({ kind: 'session', sessionId: `demo-${input.taskId}` });

      if (/^follow-up question/i.test(input.prompt) || /\?\s*$/.test(input.prompt.trim())) {
        const answer =
          "This is the demo agent, so there is no real code behind that question. With a real agent connected, I'd answer from the session's history without rerunning the task. The full explanation would appear here, with any code in the transcript and a short version read aloud.";
        for (const word of answer.split(/(?<= )/)) {
          if (cancelled()) return;
          emit({ kind: 'text', text: word, delta: true });
          await this.wait(25, run);
        }
        emit({ kind: 'text', text: answer });
        emit({ kind: 'done', outcome: 'success', finalText: answer });
        return;
      }

      emit({ kind: 'text', text: "I'll start by finding the relevant code.", delta: false });
      await this.wait(500, run);
      if (cancelled()) return;

      const search = this.nextId('tool');
      emit({ kind: 'tool_call', id: search, tool: 'Grep', summary: 'Searching for "authenticate" in src/' });
      await this.wait(700, run);
      if (cancelled()) return;
      emit({ kind: 'tool_result', id: search, ok: true, output: 'src/auth/session.ts:14: export function authenticate(token: string)\nsrc/auth/reset.ts:9: import { authenticate } from "./session"' });
      extra.push(...this.drainInbox(run));

      const read = this.nextId('tool');
      emit({ kind: 'tool_call', id: read, tool: 'Read', summary: 'Reading src/auth/session.ts' });
      await this.wait(600, run);
      if (cancelled()) return;
      emit({ kind: 'tool_result', id: read, ok: true, output: '(demo) 42 lines' });
      emit({ kind: 'text', text: 'The token expiry check compares seconds against milliseconds, so sessions expire immediately.' });
      extra.push(...this.drainInbox(run));

      if (this.opts.askApproval ?? true) {
        const approvalId = this.nextId('approval');
        const decision = await new Promise<ApprovalDecision>((resolve) => {
          run.approvals.set(approvalId, resolve);
          this.approvalOwner.set(approvalId, run);
          emit({ kind: 'approval_request', approvalId, tool: 'Edit', description: 'Edit src/auth/session.ts', detail: '- if (payload.exp < Date.now())\n+ if (payload.exp * 1000 < Date.now())' });
        });
        if (cancelled()) return;
        if (decision === 'deny') {
          const msg = 'You denied the edit, so I left the file unchanged. The bug is still present.';
          emit({ kind: 'text', text: msg });
          emit({ kind: 'done', outcome: 'success', finalText: `${msg} I could not fix it without that change.\n\nOutcome: blocked: the edit was denied` });
          return;
        }
      }

      const edit = this.nextId('tool');
      emit({ kind: 'tool_call', id: edit, tool: 'Edit', summary: 'Editing src/auth/session.ts' });
      await this.wait(400, run);
      if (cancelled()) return;
      emit({ kind: 'file_change', path: 'src/auth/session.ts', change: 'edit' });
      emit({ kind: 'tool_result', id: edit, ok: true, output: '- if (payload.exp < Date.now())\n+ if (payload.exp * 1000 < Date.now())' });
      extra.push(...this.drainInbox(run));

      let attempt = 0;
      const fail = this.opts.failFirstTest ?? false;
      for (;;) {
        attempt++;
        const cmd = this.nextId('cmd');
        emit({ kind: 'tool_call', id: cmd, tool: 'Bash', summary: 'Running npm test' });
        emit({ kind: 'command', id: cmd, command: 'npm test' });
        await this.wait(1200, run);
        if (cancelled()) return;
        if (fail && attempt === 1) {
          const out = ' FAIL  src/auth/session.test.ts > rejects expired tokens\n\n Tests  1 failed | 11 passed (12)';
          emit({ kind: 'command', id: cmd, command: 'npm test', exitCode: 1, output: out });
          emit({ kind: 'tool_result', id: cmd, ok: false, output: out });
          emit({ kind: 'text', text: 'One test failed because its fixture used millisecond expiry. Updating the fixture.' });
          const fx = this.nextId('tool');
          emit({ kind: 'tool_call', id: fx, tool: 'Edit', summary: 'Editing src/auth/session.test.ts' });
          emit({ kind: 'file_change', path: 'src/auth/session.test.ts', change: 'edit' });
          emit({ kind: 'tool_result', id: fx, ok: true });
          extra.push(...this.drainInbox(run));
          continue;
        }
        const out = ' ✓ src/auth/session.test.ts (8)\n ✓ src/auth/reset.test.ts (4)\n\n Tests  12 passed (12)';
        emit({ kind: 'command', id: cmd, command: 'npm test', exitCode: 0, output: out });
        emit({ kind: 'tool_result', id: cmd, ok: true, output: out });
        break;
      }
      extra.push(...this.drainInbox(run));

      for (const instruction of extra) {
        const step = this.nextId('tool');
        const topic = instruction.split('\n').pop()!.replace(/^(?:also|and also)\s+/i, '').slice(0, 80);
        emit({ kind: 'tool_call', id: step, tool: 'Read', summary: `Following up: ${topic}` });
        await this.wait(800, run);
        if (cancelled()) return;
        emit({ kind: 'tool_result', id: step, ok: true, output: '(demo) checked' });
      }
      // Anything that arrives after the last step is still confirmed, then handled here.
      const late = this.drainInbox(run);
      extra.push(...late);

      const followNote = extra.length ? ` I also handled your follow-up${extra.length > 1 ? 's' : ''}.` : '';
      const final = `I fixed the token expiry check in session.ts, which compared seconds with milliseconds.${followNote} The tests pass.\n\n(This was the demo agent: nothing on disk was changed.)\n\nOutcome: complete`;
      emit({ kind: 'text', text: final });
      emit({ kind: 'done', outcome: 'success', finalText: final });
    } finally {
      this.runs.delete(input.taskId);
    }
  }

  async sendFollowUp(taskId: string, followUpId: string, text: string): Promise<FollowUpReceipt> {
    const run = this.runs.get(taskId);
    if (!run) return { status: 'rejected', note: 'That task is no longer running.' };
    run.inbox.push({ id: followUpId, text });
    return { status: 'queued', note: 'Delivered; the agent will pick it up at its next step.' };
  }

  async interrupt(taskId: string): Promise<CancelResult> {
    const run = this.runs.get(taskId);
    if (!run) return { ok: false, note: 'That task is not running.' };
    run.cancelled = true;
    for (const [id, resolve] of run.approvals) {
      resolve('deny');
      this.approvalOwner.delete(id);
    }
    return { ok: true, note: 'Interrupt sent.' };
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    const run = this.approvalOwner.get(approvalId);
    run?.approvals.get(approvalId)?.(decision);
    run?.approvals.delete(approvalId);
    this.approvalOwner.delete(approvalId);
  }

  async dispose(): Promise<void> {
    for (const id of this.runs.keys()) await this.interrupt(id);
  }
}
