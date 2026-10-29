// Decides when a short spoken acknowledgement helps, and what to say.
// Wording depends on what actually happened (e.g. "queued" vs "accepted"),
// and repeated or too-frequent lines are suppressed.

export type AckReason =
  | 'task_started'
  | 'task_queued'
  | 'followup_sent'
  | 'followup_queued'
  | 'followup_accepted'
  | 'followup_rejected'
  | 'approval_needed'
  | 'test_failed'
  | 'tests_passed_midway'
  | 'agent_error'
  | 'cancel_requested'
  | 'cancelled'
  | 'cancel_failed'
  | 'priority_changed'
  | 'switched_agent';

const LINES: Record<AckReason, string[]> = {
  task_started: ["All right, I'll look into that.", 'On it.', "Okay, I'm starting on that now.", 'Sure, looking into it.'],
  task_queued: ["Got it. I'll start that once the current task finishes.", "Noted. That's queued after the current task."],
  followup_sent: ["Got it. I've passed that on.", "Understood. I've sent that to the agent."],
  followup_queued: [
    "Got it. The agent can't take that mid-step, so I'll hand it over as soon as it's ready.",
    "Noted. I'll pass that on when the agent reaches its next step.",
  ],
  followup_accepted: ["The agent's picked up your follow-up.", "Your follow-up's been taken on board."],
  followup_rejected: ["The agent didn't accept that follow-up. It's still in the transcript if you want to resend it."],
  approval_needed: ['I need your approval for something. It’s on screen.', 'The agent is waiting for your approval.'],
  test_failed: ['A test run just failed. The agent is still working on it.', "That test failed. Let's see what the agent does with it."],
  tests_passed_midway: ['The tests are passing now.'],
  agent_error: ['The agent hit an error. The details are on screen.'],
  cancel_requested: ['Stopping the task.', 'Okay, cancelling.'],
  cancelled: ['The task has stopped.'],
  cancel_failed: ["I couldn't confirm the task stopped. Check the status on screen."],
  priority_changed: ["Okay, I've changed the order."],
  switched_agent: ['Switched agents. The conversation is kept.'],
};

/** Only unprompted progress remarks are rate-limited; replies to the user and alerts always go through. */
const THROTTLED = new Set<AckReason>(['test_failed', 'tests_passed_midway', 'followup_accepted']);

/** Alerts that shouldn't repeat back-to-back (e.g. several approvals in a row). */
const REPEAT_GAP_MS: Partial<Record<AckReason, number>> = { approval_needed: 15000, test_failed: 20000 };

export class Acknowledger {
  private lastAt = 0;
  private lastByReason = new Map<AckReason, number>();
  private lastLine = '';
  private used = new Map<AckReason, number>();

  constructor(private cooldownMs = 6000, private now: () => number = Date.now) {}

  pick(reason: AckReason, extra?: string): string | null {
    const t = this.now();
    if (THROTTLED.has(reason) && t - this.lastAt < this.cooldownMs) return null;
    const gap = REPEAT_GAP_MS[reason];
    if (gap && t - (this.lastByReason.get(reason) ?? -Infinity) < gap) return null;
    this.lastByReason.set(reason, t);
    const options = LINES[reason];
    const i = (this.used.get(reason) ?? -1) + 1;
    this.used.set(reason, i);
    let line = options[i % options.length];
    if (line === this.lastLine && options.length > 1) line = options[(i + 1) % options.length];
    if (extra) line = `${line} ${extra}`;
    this.lastAt = t;
    this.lastLine = line;
    return line;
  }
}

/** Phrases a follow-up for the agent so it knows how to treat it. */
export function framedFollowUp(kind: 'add' | 'clarify' | 'prioritise', text: string): string {
  const prefix = {
    add: 'Additional instruction from the user while you work (keep going with the current task and include this as well):',
    clarify: 'Clarification from the user about the current task (continue, taking this into account):',
    prioritise: 'Priority change from the user (adjust the order of your remaining work accordingly, without restarting):',
  }[kind];
  return `${prefix}\n\n${text}`;
}
