// Claude Code adapter, built on the Claude Agent SDK (the supported
// programmatic interface; it drives the Claude Code CLI over stream-json).
//
// - Permissions: the user's own settings apply (settingSources), the mode is
//   'default', and every prompt goes to the app's approval UI via canUseTool.
//   Nothing is bypassed.
// - Follow-ups: sent into the live input stream with priority 'next', which
//   the CLI folds into the running turn at the next step boundary. A follow-up
//   counts as accepted only when the CLI stamps a reply or result with its uuid.
// - Cancel: Query.interrupt(); the terminal result confirms it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, type CanUseTool, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentAdapter,
  AgentEvent,
  AgentEventSink,
  ApprovalDecision,
  CancelResult,
  FollowUpReceipt,
  HealthReport,
  StartTaskInput,
} from '../shared/types';
import { probe } from './cliProbe';

/** Claude Code's shell tools. On Windows it may use PowerShell instead of (or as well as) Bash. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const VOICE_GUIDANCE = `The user is working with you through a voice interface that reads a short summary of your final message aloud and shows everything else on screen.
- Begin your final message with one or two plain-language sentences saying what you did and the outcome, with no code or file paths in them.
- Say explicitly which tests or checks you ran and whether they passed. Never claim a test passed unless you ran it.
- If you could not finish something, say so plainly.
- End your final message with exactly one line of the form "Outcome: complete", "Outcome: partial: <what is left>" or "Outcome: blocked: <why>". Use complete only if everything asked, including follow-up instructions, was done and verified.
- The user may add instructions while you work. Treat them as part of the current task unless they say otherwise.`;

/** Minimal async queue used as the SDK's streaming input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.closed) throw new Error('input closed');
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface ToolInfo {
  name: string;
  input: Record<string, unknown>;
  filePath?: string;
  existedBefore?: boolean;
}

interface Run {
  taskId: string;
  q: Query | null;
  input: InputQueue;
  sink: AgentEventSink;
  cwd: string;
  /** Follow-ups sent but not yet stamped as consumed by the CLI. */
  outstanding: Set<string>;
  interrupted: boolean;
  tools: Map<string, ToolInfo>;
  approvals: Map<string, { resolve: (d: ApprovalDecision) => void }>;
  /** Tool calls the user denied: they never ran, so they produce no exit code. */
  denied: Set<string>;
  streamedText: boolean;
  lastText: string;
}

export interface ClaudeAdapterOptions {
  /** Override for the CLI path; by default the SDK finds Claude Code itself. */
  executable?: string;
  model?: string;
  queryFn?: typeof query;
}

type Log = { write(level: 'info' | 'warn' | 'error', msg: string): void };

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';
  readonly capabilities = { midTaskInput: 'between-steps', interrupt: true, approvals: true, resume: true } as const;
  private runs = new Map<string, Run>();
  private approvalOwner = new Map<string, Run>();
  private sessionId: string | null = null;
  private seq = 0;

  constructor(private log: Log, private opts: ClaudeAdapterOptions = {}) {}

  async check(): Promise<HealthReport> {
    const r = await probe(this.opts.executable ?? 'claude', ['--version']);
    if (!r.found)
      return { ok: false, installed: false, detail: 'Claude Code is not installed.', fix: 'npm install -g @anthropic-ai/claude-code, then run "claude" once to sign in.' };
    if (r.code !== 0) return { ok: false, installed: true, detail: `claude --version failed: ${r.stderr || r.stdout}`.slice(0, 300) };
    // `claude auth status` prints JSON; its exit code isn't a reliable signal on every version.
    const auth = await probe(this.opts.executable ?? 'claude', ['auth', 'status']);
    let signedIn: boolean | undefined;
    try {
      signedIn = (JSON.parse(auth.stdout) as { loggedIn?: boolean }).loggedIn === true;
    } catch {
      signedIn = auth.code === 0 ? !/not (?:logged|signed) in|no credentials/i.test(auth.stdout + auth.stderr) : undefined;
    }
    return {
      ok: signedIn === true,
      installed: true,
      authenticated: signedIn,
      version: r.stdout.split(/\s/)[0],
      detail: signedIn ? `Claude Code ${r.stdout} is ready.` : `Claude Code ${r.stdout} is installed but ${signedIn === false ? 'not signed in' : 'its sign-in could not be checked'}.`,
      fix: signedIn ? undefined : 'Run "claude" in a terminal and sign in, then press Recheck.',
    };
  }

  private emit(run: Run, e: AgentEvent): void {
    run.sink(run.taskId, e);
  }

  async start(input: StartTaskInput, sink: AgentEventSink): Promise<void> {
    const run: Run = {
      taskId: input.taskId,
      q: null,
      input: new InputQueue(),
      sink,
      cwd: input.cwd,
      outstanding: new Set(),
      interrupted: false,
      tools: new Map(),
      approvals: new Map(),
      denied: new Set(),
      streamedText: false,
      lastText: '',
    };
    this.runs.set(input.taskId, run);
    const prompt = input.handoff ? `${input.handoff}\n\n---\n\nNew request:\n${input.prompt}` : input.prompt;
    run.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });

    const canUseTool: CanUseTool = async (toolName, toolInput, { signal, toolUseID }) => {
      if (toolName === 'AskUserQuestion') {
        return { behavior: 'deny', message: 'This user is on a voice interface. Ask your question in plain text in your reply and stop there.' };
      }
      const approvalId = `claude-approval-${++this.seq}`;
      const { description, detail } = describeTool(toolName, toolInput, run.cwd);
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        run.approvals.set(approvalId, { resolve });
        this.approvalOwner.set(approvalId, run);
        signal.addEventListener('abort', () => resolve('deny'), { once: true });
        this.emit(run, { kind: 'approval_request', approvalId, tool: toolName, description, detail });
      });
      run.approvals.delete(approvalId);
      this.approvalOwner.delete(approvalId);
      this.emit(run, { kind: 'approval_resolved', approvalId, decision });
      if (decision === 'deny' && toolUseID) run.denied.add(toolUseID);
      return decision === 'allow'
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'The user denied this action. Do not retry it; explain what you would have done instead.' };
    };

    let finished = false;
    const finish = (e: Extract<AgentEvent, { kind: 'done' }>) => {
      if (finished) return;
      finished = true;
      run.input.close();
      this.emit(run, e);
    };

    try {
      const q = (this.opts.queryFn ?? query)({
        prompt: run.input,
        options: {
          cwd: input.cwd,
          permissionMode: 'default',
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_GUIDANCE },
          canUseTool,
          includePartialMessages: true,
          resume: this.sessionId ?? undefined,
          model: this.opts.model,
          pathToClaudeCodeExecutable: this.opts.executable,
          stderr: (d) => this.log.write('warn', `[claude stderr] ${d.trim()}`),
        },
      });
      run.q = q;

      for await (const m of q) {
        this.handle(run, m, finish);
        if (finished) break;
      }
      if (!finished) {
        finish(
          run.interrupted
            ? { kind: 'done', outcome: 'cancelled', finalText: run.lastText }
            : { kind: 'done', outcome: 'error', error: 'Claude Code ended the session without a result.' },
        );
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.log.write('error', `Claude run failed: ${(err as Error).stack ?? msg}`);
      finish(run.interrupted ? { kind: 'done', outcome: 'cancelled' } : { kind: 'done', outcome: 'error', error: explainError(msg) });
    } finally {
      for (const a of run.approvals.values()) a.resolve('deny');
      try {
        run.q?.close?.();
      } catch {
        /* already closed */
      }
      this.runs.delete(input.taskId);
    }
  }

  private handle(run: Run, m: SDKMessage, finish: (e: Extract<AgentEvent, { kind: 'done' }>) => void): void {
    const stamp = (uuid?: string, uuids?: string[]) => {
      for (const id of [uuid, ...(uuids ?? [])]) {
        if (id && run.outstanding.delete(id)) {
          this.emit(run, { kind: 'followup_status', followUpId: id, status: 'accepted', note: 'Claude Code took it into the running task.' });
        }
      }
    };

    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id;
          this.emit(run, { kind: 'session', sessionId: m.session_id });
        }
        return;

      case 'stream_event': {
        if (m.parent_tool_use_id) return; // subagent chatter stays out of the main transcript
        const ev = m.event as { type: string; delta?: { type: string; text?: string } };
        stamp((m as { user_message_uuid?: string }).user_message_uuid);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          run.streamedText = true;
          this.emit(run, { kind: 'text', text: ev.delta.text, delta: true });
        }
        return;
      }

      case 'assistant': {
        stamp((m as { user_message_uuid?: string }).user_message_uuid);
        if (m.parent_tool_use_id) return;
        const blocks = (m.message.content ?? []) as unknown as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        const text = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n');
        if (text) {
          run.lastText = text;
          this.emit(run, { kind: 'text', text });
          run.streamedText = false;
        }
        for (const b of blocks) {
          if (b.type !== 'tool_use' || !b.id || !b.name) continue;
          const input = b.input ?? {};
          const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
          const abs = filePath ? path.resolve(run.cwd, filePath) : undefined;
          run.tools.set(b.id, { name: b.name, input, filePath, existedBefore: abs ? fs.existsSync(abs) : undefined });
          this.emit(run, { kind: 'tool_call', id: b.id, tool: b.name, summary: describeTool(b.name, input, run.cwd).description, input });
          if (SHELL_TOOLS.has(b.name) && typeof input.command === 'string') this.emit(run, { kind: 'command', id: b.id, command: input.command });
        }
        return;
      }

      case 'user': {
        if (m.parent_tool_use_id) return;
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        for (const b of content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          const info = run.tools.get(b.tool_use_id);
          if (run.denied.has(b.tool_use_id)) {
            const note = 'Not run: you denied this action.';
            this.emit(run, { kind: 'tool_result', id: b.tool_use_id, ok: false, output: note });
            if (info && SHELL_TOOLS.has(info.name)) this.emit(run, { kind: 'command', id: b.tool_use_id, command: String(info.input.command ?? ''), output: note });
            continue;
          }
          const output = toolResultText(b.content);
          const ok = !b.is_error;
          this.emit(run, { kind: 'tool_result', id: b.tool_use_id, ok, output });
          if (info && SHELL_TOOLS.has(info.name)) {
            this.emit(run, { kind: 'command', id: b.tool_use_id, command: String(info.input.command ?? ''), exitCode: bashExitCode(ok, output), output });
          }
          if (ok && info?.filePath && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(info.name)) {
            this.emit(run, { kind: 'file_change', path: path.relative(run.cwd, path.resolve(run.cwd, info.filePath)) || info.filePath, change: info.existedBefore ? 'edit' : 'create' });
          }
        }
        return;
      }

      case 'result': {
        const r = m as typeof m & { user_message_uuid?: string; user_message_uuids?: string[]; result?: string; errors?: string[] };
        stamp(r.user_message_uuid, r.user_message_uuids);
        if (run.interrupted) {
          finish({ kind: 'done', outcome: 'cancelled', finalText: r.result ?? run.lastText });
          return;
        }
        // Follow-ups still queued in the CLI will run as further turns; wait for them.
        if (run.outstanding.size) {
          this.emit(run, { kind: 'status', text: 'Applying your follow-up as a further step.' });
          return;
        }
        if (r.subtype === 'success') finish({ kind: 'done', outcome: 'success', finalText: r.result || run.lastText });
        else finish({ kind: 'done', outcome: 'error', finalText: run.lastText, error: explainError(r.errors?.join('; ') || r.subtype) });
        return;
      }
    }
  }

  async sendFollowUp(taskId: string, followUpId: string, text: string): Promise<FollowUpReceipt> {
    const run = this.runs.get(taskId);
    if (!run) return { status: 'rejected', note: 'That task is no longer running.' };
    try {
      run.outstanding.add(followUpId);
      run.input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        priority: 'next',
        uuid: followUpId as SDKUserMessage['uuid'],
      });
      return { status: 'queued', note: 'Sent to Claude Code; it is taken in at the next step boundary.' };
    } catch (err) {
      run.outstanding.delete(followUpId);
      return { status: 'rejected', note: `Could not send: ${(err as Error).message}` };
    }
  }

  async interrupt(taskId: string): Promise<CancelResult> {
    const run = this.runs.get(taskId);
    if (!run?.q) return { ok: false, note: 'That task is not running.' };
    run.interrupted = true;
    for (const a of run.approvals.values()) a.resolve('deny');
    try {
      await run.q.interrupt();
      return { ok: true, note: 'Interrupt sent to Claude Code.' };
    } catch (err) {
      return { ok: false, note: `Interrupt failed: ${(err as Error).message}` };
    }
  }

  respondToApproval(approvalId: string, decision: ApprovalDecision): void {
    this.approvalOwner.get(approvalId)?.approvals.get(approvalId)?.resolve(decision);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.interrupt(id);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return '';
}

/** Claude Code reports a failing shell command as an error result containing "Exit code N". */
export function bashExitCode(ok: boolean, output: string): number {
  const m = output.match(/Exit code (\d+)/i);
  if (m) return Number(m[1]);
  return ok ? 0 : 1;
}

export function describeTool(name: string, input: Record<string, unknown>, cwd: string): { description: string; detail?: string } {
  const rel = (p: unknown) => (typeof p === 'string' ? path.relative(cwd, path.resolve(cwd, p)) || p : '?');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { description: `Run: ${String(input.command ?? '').split('\n')[0].slice(0, 120)}`, detail: String(input.command ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return {
        description: `Edit ${rel(input.file_path)}`,
        detail: input.old_string !== undefined ? `- ${String(input.old_string)}\n+ ${String(input.new_string ?? '')}` : JSON.stringify(input.edits ?? input, null, 2).slice(0, 4000),
      };
    case 'Write':
      return { description: `Write ${rel(input.file_path)}`, detail: String(input.content ?? '').slice(0, 4000) };
    case 'NotebookEdit':
      return { description: `Edit notebook ${rel(input.notebook_path)}` };
    case 'Read':
      return { description: `Read ${rel(input.file_path)}` };
    case 'Grep':
      return { description: `Search for "${String(input.pattern ?? '')}"${input.path ? ` in ${rel(input.path)}` : ''}` };
    case 'Glob':
      return { description: `Find files matching ${String(input.pattern ?? '')}` };
    case 'WebFetch':
      return { description: `Fetch ${String(input.url ?? '')}` };
    case 'WebSearch':
      return { description: `Web search: ${String(input.query ?? '')}` };
    case 'Task':
    case 'Agent':
      return { description: `Start a sub-agent: ${String(input.description ?? '')}` };
    default:
      return { description: name, detail: JSON.stringify(input, null, 2).slice(0, 4000) };
  }
}

function explainError(msg: string): string {
  if (/ENOENT|not found|cannot find/i.test(msg)) return `Claude Code could not be started (${msg}). Check that it is installed.`;
  if (/auth|login|401|api key|credential/i.test(msg)) return `Claude Code is not signed in (${msg}). Run "claude" in a terminal to sign in.`;
  if (/ECONN|ETIMEDOUT|network|fetch failed|ENOTFOUND|overloaded|529/i.test(msg)) return `Network or service problem talking to Claude (${msg}). Try again shortly.`;
  return msg;
}
