import { describe, expect, it } from 'vitest';
import { buildReport, emptyEvidence, isTestCommand, parseSelfReport, parseTestCounts, recordEvidence, testKey } from '../../src/core/evidence';
import type { TaskInfo } from '../../src/shared/types';

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 't1',
    title: 'Fix auth',
    prompt: 'Fix the auth bug and run the tests',
    agentId: 'demo',
    state: 'completed',
    priority: 0,
    followUps: [],
    evidence: emptyEvidence(),
    createdAt: 0,
    finalText: 'Fixed the expiry comparison. Tests pass.',
    ...overrides,
  };
}

describe('test command detection and parsing', () => {
  it.each(['npm test', 'node --test', 'npm run test -- --watch=false', 'npx vitest run', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test'])(
    'recognises %s',
    (c) => expect(isTestCommand(c)).toBe(true),
  );
  it.each(['npm install', 'git status', 'ls tests/'])('ignores %s', (c) => expect(isTestCommand(c)).toBe(false));

  it('parses vitest, jest, pytest, mocha and go output', () => {
    expect(parseTestCounts(' Tests  1 failed | 11 passed (12)')).toEqual({ passed: 11, failed: 1, skipped: 0 });
    expect(parseTestCounts('Tests:       2 failed, 5 passed, 7 total')).toEqual({ passed: 5, failed: 2, skipped: 0 });
    expect(parseTestCounts('==== 3 passed, 1 skipped in 0.12s ====')).toEqual({ passed: 3, failed: 0, skipped: 1 });
    expect(parseTestCounts('  4 passing (20ms)\n  1 failing')).toEqual({ passed: 4, failed: 1, skipped: 0 });
    expect(parseTestCounts('--- PASS: TestA\n--- FAIL: TestB\n--- PASS: TestC')).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(parseTestCounts('# tests 2\n# suites 0\n# pass 2\n# fail 0')).toEqual({ passed: 2, failed: 0, skipped: 0 });
    expect(parseTestCounts('ℹ tests 3\nℹ pass 2\nℹ fail 1')).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(parseTestCounts('nothing useful')).toBeUndefined();
  });
});

describe('buildReport', () => {
  it('reports completed only with passing test evidence', () => {
    const t = task();
    recordEvidence(t.evidence, { kind: 'file_change', path: 'src/a.ts', change: 'edit' });
    recordEvidence(t.evidence, { kind: 'command', id: 'c1', command: 'npm test' });
    recordEvidence(t.evidence, { kind: 'command', id: 'c1', command: 'npm test', exitCode: 0, output: 'Tests  4 passed (4)' });
    const r = buildReport(t);
    expect(r.outcome).toBe('completed');
    expect(r.passed).toHaveLength(1);
    expect(r.markdown).toContain('Edited `src/a.ts`');
    expect(r.spoken).toContain('passed');
  });

  it('never claims tests passed when none ran', () => {
    const t = task();
    recordEvidence(t.evidence, { kind: 'file_change', path: 'src/a.ts', change: 'edit' });
    const r = buildReport(t);
    expect(r.spoken).toContain('No tests were run');
    expect(r.spoken).not.toMatch(/passed/);
    expect(r.issues.join(' ')).toContain('no test command was run');
  });

  it('uses the latest run of a test command', () => {
    const t = task();
    recordEvidence(t.evidence, { kind: 'command', id: 'c1', command: 'npm test', exitCode: 1, output: 'Tests  1 failed | 3 passed (4)' });
    recordEvidence(t.evidence, { kind: 'command', id: 'c2', command: 'npm test', exitCode: 0, output: 'Tests  4 passed (4)' });
    expect(buildReport(t).outcome).toBe('completed');
  });

  it('treats reruns with different pipes or cd prefixes as the same test', () => {
    const t = task();
    recordEvidence(t.evidence, { kind: 'command', id: 'c1', command: 'cd "C:/x" && npm test 2>&1 | tail -40', exitCode: 0, output: '# pass 1\n# fail 1' });
    recordEvidence(t.evidence, { kind: 'command', id: 'c2', command: 'npm test 2>&1 | tail -12', exitCode: 0, output: '# pass 2\n# fail 0' });
    const r = buildReport(t);
    expect(r.outcome).toBe('completed');
    expect(r.failed).toHaveLength(0);
    expect(testKey('cd "C:/x" && npm test 2>&1 | tail -40')).toBe('npm test');
  });

  it('marks partial when tests still fail', () => {
    const t = task();
    recordEvidence(t.evidence, { kind: 'command', id: 'c1', command: 'pytest', exitCode: 1, output: '1 failed, 2 passed in 0.1s' });
    const r = buildReport(t);
    expect(r.outcome).toBe('partial');
    expect(r.spoken).toContain('still failed');
  });

  it('marks partial when a follow-up was never confirmed', () => {
    const t = task({ followUps: [{ id: 'f', text: 'check resets', kind: 'add', status: 'queued', at: 0 }] });
    const r = buildReport(t);
    expect(r.outcome).toBe('partial');
    expect(r.issues.join(' ')).toContain('never confirmed');
  });

  it("marks partial only from the agent's explicit outcome line", () => {
    const text = "I couldn't fix the second bug.\n\nOutcome: partial: second bug remains";
    const r = buildReport(task({ finalText: text, selfReport: parseSelfReport(text) }));
    expect(r.outcome).toBe('partial');
    expect(r.issues.join(' ')).toContain('second bug remains');
    expect(r.why).not.toContain('Outcome:');
  });

  it('does not guess from prose (an aside like "I did not run X" is not a failure)', () => {
    expect(buildReport(task({ finalText: 'Fixed it. I did not run any docs tools.' })).outcome).toBe('completed');
  });

  it('parses outcome lines in common shapes', () => {
    expect(parseSelfReport('done\nOutcome: complete')).toEqual({ status: 'complete' });
    expect(parseSelfReport('**Outcome:** blocked — needs a DB password')).toEqual({ status: 'blocked', note: 'needs a DB password' });
    expect(parseSelfReport('no outcome here')).toBeUndefined();
  });

  it('keeps failed and cancelled outcomes', () => {
    expect(buildReport(task({ state: 'failed', error: 'Agent crashed' })).outcome).toBe('failed');
    expect(buildReport(task({ state: 'cancelled' })).outcome).toBe('cancelled');
  });
});
