// Builds an evidence record from structured agent events and turns it into a
// completion report. Claims in the report come only from recorded evidence.

import type { AgentEvent, CommandRecord, CompletionReport, Evidence, SelfReport, TaskInfo } from '../shared/types';

const TEST_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npx\s+)?(?:vitest|jest|mocha|ava|playwright\s+test)\b|\bnode\s+--test\b|\bpytest\b|\bpython\d*\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\b(?:mvn|gradlew?)\s+\S*test\b|\brspec\b|\bphpunit\b|\bctest\b/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/**
 * The test-runner call inside a shell line, so `cd x && npm test 2>&1 | tail -40`
 * and `npm test | tail -12` count as reruns of the same test.
 */
export function testKey(command: string): string {
  const part = command.split(/&&|\|\||;|\|/).find((p) => TEST_COMMAND.test(p)) ?? command;
  return part
    .replace(/\d?>&?\d?\s*\S*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort pass/fail counts from common test runner summaries. */
export function parseTestCounts(output: string): CommandRecord['tests'] | undefined {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let found = false;
  const grab = (re: RegExp) => {
    const m = text.match(re);
    if (m) found = true;
    return m ? Number(m[1]) : 0;
  };
  // Vitest / Jest: "Tests  3 failed | 12 passed (15)" or "Tests: 1 failed, 4 passed, 5 total"
  const testsLine = text.match(/^\s*Tests:?\s+(.*)$/m);
  if (testsLine) {
    const l = testsLine[1];
    passed = Number(l.match(/(\d+)\s+passed/)?.[1] ?? 0);
    failed = Number(l.match(/(\d+)\s+failed/)?.[1] ?? 0);
    skipped = Number(l.match(/(\d+)\s+(?:skipped|todo|pending)/)?.[1] ?? 0);
    found = /\d+\s+(?:passed|failed)/.test(l);
  }
  if (!found) {
    // pytest: "==== 2 failed, 10 passed, 1 skipped in 0.5s ===="
    passed = grab(/(\d+)\s+passed/);
    failed = grab(/(\d+)\s+failed/);
    skipped = grab(/(\d+)\s+skipped/);
  }
  if (!found) {
    // Go: count "--- PASS" / "--- FAIL"; Cargo: "test result: ok. 5 passed; 0 failed"
    const goPass = (text.match(/^--- PASS/gm) ?? []).length;
    const goFail = (text.match(/^--- FAIL/gm) ?? []).length;
    if (goPass + goFail > 0) return { passed: goPass, failed: goFail, skipped: 0 };
    // node --test (TAP or spec reporter): "# pass 5" / "ℹ pass 5"
    const np = text.match(/^\s*[#ℹ]\s*pass\s+(\d+)/m);
    const nf = text.match(/^\s*[#ℹ]\s*fail\s+(\d+)/m);
    if (np || nf) return { passed: Number(np?.[1] ?? 0), failed: Number(nf?.[1] ?? 0), skipped: Number(text.match(/^\s*[#ℹ]\s*skipped\s+(\d+)/m)?.[1] ?? 0) };
    // Mocha: "5 passing", "1 failing"
    const mp = text.match(/(\d+)\s+passing/);
    const mf = text.match(/(\d+)\s+failing/);
    if (mp || mf) return { passed: Number(mp?.[1] ?? 0), failed: Number(mf?.[1] ?? 0), skipped: 0 };
  }
  return found ? { passed, failed, skipped } : undefined;
}

export function emptyEvidence(): Evidence {
  return { files: [], commands: [], approvals: [] };
}

/** Mutates `ev` with what an agent event proves happened. */
export function recordEvidence(ev: Evidence, e: AgentEvent): void {
  switch (e.kind) {
    case 'file_change': {
      const existing = ev.files.find((f) => f.path === e.path);
      if (existing) {
        if (e.change === 'delete' || existing.change !== 'create') existing.change = e.change;
      } else ev.files.push({ path: e.path, change: e.change });
      break;
    }
    case 'command': {
      const isTest = isTestCommand(e.command);
      const existing = ev.commands.find((c) => c.id === e.id);
      const rec: CommandRecord = existing ?? { id: e.id, command: e.command, isTest };
      if (e.exitCode !== undefined) rec.exitCode = e.exitCode;
      if (e.output !== undefined) {
        rec.output = e.output;
        if (isTest) rec.tests = parseTestCounts(e.output);
      }
      if (!existing) ev.commands.push(rec);
      break;
    }
    case 'approval_request':
      ev.approvals.push({ id: e.approvalId, tool: e.tool, description: e.description });
      break;
    case 'approval_resolved': {
      const a = ev.approvals.find((x) => x.id === e.approvalId);
      if (a) a.decision = e.decision;
      break;
    }
  }
}

const OUTCOME_LINE = /^\s*\**Outcome:?\**\s*(complete|partial|blocked)\b[\s:—–-]*(.*)$/im;

/** Reads the agent's explicit `Outcome:` line. Free text is never guessed at. */
export function parseSelfReport(text: string): SelfReport | undefined {
  const m = text.match(OUTCOME_LINE);
  if (!m) return undefined;
  const note = m[2].trim().replace(/\**$/, '').trim();
  return { status: m[1].toLowerCase() as SelfReport['status'], note: note || undefined };
}

/** The final message without its machine-readable outcome line. */
export function stripOutcomeLine(text: string): string {
  return text.replace(OUTCOME_LINE, '').trim();
}

function testLabel(c: CommandRecord): string {
  const counts = c.tests ? ` (${c.tests.passed} passed, ${c.tests.failed} failed${c.tests.skipped ? `, ${c.tests.skipped} skipped` : ''})` : '';
  return `\`${c.command}\` → exit ${c.exitCode ?? '?'}${counts}`;
}

function firstSentences(text: string, n: number): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  return parts.slice(0, n).join(' ').trim();
}

export function buildReport(task: TaskInfo): CompletionReport {
  const ev = task.evidence;
  const final = stripOutcomeLine(task.finalText?.trim() ?? '');
  const self = task.selfReport;
  const selfIncomplete = self && self.status !== 'complete';
  const tests = ev.commands.filter((c) => c.isTest && c.exitCode !== undefined);
  // The last run of each distinct test command is what counts.
  const latest = new Map<string, CommandRecord>();
  for (const c of tests) latest.set(testKey(c.command), c);
  const lastTests = [...latest.values()];
  const passed = lastTests.filter((c) => c.exitCode === 0 && (c.tests?.failed ?? 0) === 0);
  const failed = lastTests.filter((c) => !(c.exitCode === 0 && (c.tests?.failed ?? 0) === 0));
  // Commands without an exit code never completed (denied, cancelled or still running): not checks.
  const otherChecks = ev.commands.filter((c) => !c.isTest && c.exitCode !== undefined);
  const unaccepted = task.followUps.filter((f) => f.status !== 'accepted');
  const denied = ev.approvals.filter((a) => a.decision === 'deny');
  const pendingApprovals = ev.approvals.filter((a) => !a.decision);

  const issues: string[] = [];
  if (failed.length) issues.push(`${failed.length} test command(s) did not pass on their last run.`);
  if (unaccepted.length)
    issues.push(...unaccepted.map((f) => `Follow-up "${f.text}" was ${f.status === 'rejected' ? 'rejected' : 'never confirmed as received'} by the agent.`));
  if (denied.length) issues.push(...denied.map((a) => `You denied: ${a.description}`));
  if (selfIncomplete) issues.push(`The agent reported the work as ${self!.status}${self!.note ? `: ${self!.note}` : '.'}`);
  if (ev.files.length && !tests.length) issues.push('Files were changed but no test command was run.');

  let outcome: CompletionReport['outcome'];
  if (task.state === 'cancelled') outcome = 'cancelled';
  else if (task.state === 'failed') outcome = 'failed';
  else if (failed.length || unaccepted.length || selfIncomplete || denied.length) outcome = 'partial';
  else outcome = 'completed';

  const changed = ev.files.map((f) => `${f.change === 'create' ? 'Created' : f.change === 'delete' ? 'Deleted' : 'Edited'} \`${f.path}\``);
  const why = final ? firstSentences(final, 2) : task.error ?? 'The agent gave no explanation.';
  const checks = [...lastTests.map(testLabel), ...otherChecks.slice(-5).map((c) => `\`${c.command}\` → exit ${c.exitCode ?? '?'}`)];
  const followUpLines = task.followUps.map((f) => `- "${f.text}" (${f.kind}): **${f.status}**${f.note ? ` · ${f.note}` : ''}`);

  const heading = { completed: 'Completed', partial: 'Partially completed', failed: 'Failed', cancelled: 'Cancelled' }[outcome];
  const md = [
    `### ${heading}`,
    `**Asked:** ${task.prompt}`,
    followUpLines.length ? `**Follow-ups:**\n${followUpLines.join('\n')}` : '',
    `**Changed:** ${changed.length ? `\n${changed.map((c) => `- ${c}`).join('\n')}` : 'No file changes were recorded.'}`,
    `**Why:** ${why}`,
    `**Checks run:** ${checks.length ? `\n${checks.map((c) => `- ${c}`).join('\n')}` : 'None recorded.'}`,
    `**Tests:** ${lastTests.length ? `${passed.length} passed, ${failed.length} failed (by command)` : 'No tests were run.'}`,
    issues.length ? `**Remaining issues:**\n${issues.map((i) => `- ${i}`).join('\n')}` : '',
    pendingApprovals.length ? `**Awaiting your approval:**\n${pendingApprovals.map((a) => `- ${a.description}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    outcome,
    asked: task.prompt,
    changed,
    why,
    checks,
    passed: passed.map(testLabel),
    failed: failed.map(testLabel),
    issues,
    needsApproval: pendingApprovals.map((a) => a.description),
    markdown: md,
    spoken: spokenSummary(outcome, task, ev.files.length, lastTests.length, passed.length, failed.length, issues.length, task.error),
  };
}

function spokenSummary(
  outcome: CompletionReport['outcome'],
  task: TaskInfo,
  files: number,
  testRuns: number,
  passed: number,
  failed: number,
  issues: number,
  error?: string,
): string {
  if (outcome === 'cancelled') return 'The task was cancelled. What it finished before stopping is in the transcript.';
  if (outcome === 'failed') return `The task failed${error ? `: ${error.split(/[.\n]/)[0]}` : ''}. The details are on screen.`;
  const parts: string[] = [];
  parts.push(outcome === 'completed' ? "I've finished." : "I've finished, but not everything is done.");
  if (files) parts.push(`${files} file${files === 1 ? ' was' : 's were'} changed.`);
  else parts.push('No files were changed.');
  if (!testRuns) parts.push('No tests were run.');
  else if (!failed) parts.push(passed === 1 ? 'The test run passed.' : 'All the test runs passed.');
  else parts.push(`${failed} test run${failed === 1 ? '' : 's'} still failed.`);
  const accepted = task.followUps.filter((f) => f.status === 'accepted').length;
  if (accepted) parts.push(`Your follow-up${accepted === 1 ? ' was' : 's were'} included.`);
  if (issues && outcome === 'partial') parts.push("I've listed what's left on screen.");
  return parts.join(' ');
}
