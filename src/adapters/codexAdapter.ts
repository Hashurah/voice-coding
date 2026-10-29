// Codex adapter. Phase 4b: the JSON-RPC integration with `codex app-server`
// is not built yet because Codex isn't installed or signed in on the
// development machine. Until then this adapter only reports its status
// honestly and refuses tasks.

import type {
  AgentAdapter,
  AgentEventSink,
  CancelResult,
  FollowUpReceipt,
  HealthReport,
  StartTaskInput,
} from '../shared/types';
import { probe } from './cliProbe';

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly capabilities = { midTaskInput: 'none', interrupt: false, approvals: false, resume: false } as const;

  async check(): Promise<HealthReport> {
    const r = await probe('codex', ['--version']);
    if (!r.found)
      return {
        ok: false,
        installed: false,
        detail: 'Codex CLI is not installed.',
        fix: 'npm install -g @openai/codex, then run "codex login".',
      };
    return {
      ok: false,
      installed: true,
      version: r.stdout,
      detail: `Codex ${r.stdout} is installed, but this app's Codex adapter is not finished yet.`,
      fix: 'Use Claude Code or the demo agent for now.',
    };
  }

  async start(input: StartTaskInput, sink: AgentEventSink): Promise<void> {
    sink(input.taskId, {
      kind: 'done',
      outcome: 'error',
      error: "The Codex adapter isn't available yet. Switch to Claude Code or the demo agent; your transcript is kept.",
    });
  }

  async sendFollowUp(): Promise<FollowUpReceipt> {
    return { status: 'rejected', note: 'Codex adapter not available.' };
  }

  async interrupt(): Promise<CancelResult> {
    return { ok: false, note: 'Codex adapter not available.' };
  }

  respondToApproval(): void {}

  async dispose(): Promise<void> {}
}
