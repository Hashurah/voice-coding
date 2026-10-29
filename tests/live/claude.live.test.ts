// Live tests against the real Claude Code CLI, in a throwaway project.
// Costs tokens on your Claude account. Run with: npm run test:live
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claudeAdapter';
import { TaskManager } from '../../src/core/taskManager';
import type { Settings, TaskInfo, TranscriptEntry, UiEvent } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';

const model = process.env.VCC_CLAUDE_MODEL || 'haiku';
let dir: string;
let tm: TaskManager;
let adapter: ClaudeAdapter;
const events: UiEvent[] = [];
const approvals: { tool: string; description: string; decision: 'allow' | 'deny' }[] = [];
const logLines: string[] = [];

function writeProject(root: string): void {
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w('package.json', JSON.stringify({ name: 'auth-demo', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2));
  w(
    'src/auth.js',
    `// Tokens carry exp as seconds since the Unix epoch.
export function isTokenValid(token, now = Date.now()) {
  return token.exp > now;
}

export function authenticate(token) {
  if (!isTokenValid(token)) throw new Error('Token expired');
  return token.sub;
}
`,
  );
  w(
    'src/reset.js',
    `import { isTokenValid } from './auth.js';

// Password-reset tokens use the same expiry format as session tokens.
export function canResetPassword(resetToken) {
  return isTokenValid(resetToken) && resetToken.purpose === 'reset';
}
`,
  );
  w(
    'test/auth.test.js',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from '../src/auth.js';

const nowSec = () => Math.floor(Date.now() / 1000);

test('accepts a token that expires in an hour', () => {
  assert.equal(authenticate({ sub: 'ana', exp: nowSec() + 3600 }), 'ana');
});

test('rejects an expired token', () => {
  assert.throws(() => authenticate({ sub: 'ana', exp: nowSec() - 10 }));
});
`,
  );
}

const settings: Settings = { ...DEFAULT_SETTINGS, agentId: 'claude' };
const until = async (cond: () => boolean, ms: number, what: string) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`Timed out after ${ms / 1000}s waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const tasks = () => [...tm.tasks.values()];
const finished = (t?: TaskInfo) => !!t && ['completed', 'partial', 'failed', 'cancelled'].includes(t.state);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-live-'));
  writeProject(dir);
  settings.cwd = dir;
  adapter = new ClaudeAdapter({ write: (l, m) => logLines.push(`${l} ${m}`) }, { model });
  tm = new TaskManager({
    adapters: { claude: adapter },
    settings: () => settings,
    cancelTimeoutMs: 30_000,
    emit: (e) => {
      events.push(e);
      // Plays the user at the approval prompt: only actions inside the throwaway project.
      if (e.type === 'entry' && e.entry.type === 'approval') {
        const a = e.entry as Extract<TranscriptEntry, { type: 'approval' }>;
        const detail = `${a.description}\n${a.detail ?? ''}`;
        const insideProject = /^(?:Edit|Write|MultiEdit)$/.test(a.tool) && !/\.\.[\\/]/.test(a.description);
        const cmd = a.detail ?? '';
        const safeCommand =
          (a.tool === 'Bash' || a.tool === 'PowerShell') &&
          /(?:npm (?:run )?test|node --test|\bnode\b.*\s-e\s|^cat |^type |^ls|^dir)/.test(cmd) &&
          !/\b(?:rm|del|Remove-Item|rmdir|git push|curl|Invoke-WebRequest)\b/i.test(cmd);
        const decision = insideProject || safeCommand ? 'allow' : 'deny';
        approvals.push({ tool: a.tool, description: detail.slice(0, 160), decision });
        setTimeout(() => tm.approve(a.id, decision), 300);
      }
    },
  });
});

afterAll(async () => {
  await tm?.shutdown();
  console.log(`\nApprovals answered:\n${approvals.map((a) => `  ${a.decision.toUpperCase()} ${a.tool}: ${a.description.split('\n')[0]}`).join('\n')}`);
  console.log(`Project: ${dir}`);
});

describe(`Claude Code live (${model})`, () => {
  it('reports health', async () => {
    const h = await adapter.check();
    console.log('health:', h);
    expect(h.installed).toBe(true);
    expect(h.ok).toBe(true);
  });

  it('runs a task, takes a mid-task follow-up without restarting, and reports evidence', async () => {
    await tm.submit('Find and fix the bug in this project that makes valid tokens look expired, then run npm test.', 'voice');
    await until(() => tm.entries.some((e) => e.type === 'tool'), 120_000, 'first tool call');
    const before = tasks().length;
    await tm.submit('Also check whether the fix affects the password reset code in src/reset.js.', 'voice');
    expect(tasks().length).toBe(before); // added to the running task, not a new one
    const t = tasks()[0];
    expect(t.followUps[0].kind).toBe('add');
    console.log('follow-up right after sending:', t.followUps[0].status, '-', t.followUps[0].note);

    await until(() => finished(tasks()[0]), 400_000, 'task completion');
    const done = tasks()[0];
    console.log('\nREPORT\n' + done.report?.markdown);
    console.log('follow-up final status:', done.followUps[0]);
    console.log('spoken:', events.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text));

    expect(done.state).toBe('completed');
    expect(done.followUps[0].status).toBe('accepted');
    expect(done.evidence.files.map((f) => f.path.replace(/\\/g, '/'))).toContain('src/auth.js');
    const testRuns = done.evidence.commands.filter((c) => c.isTest && c.exitCode !== undefined);
    expect(testRuns.length).toBeGreaterThan(0);
    expect(testRuns.at(-1)!.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'src/auth.js'), 'utf8')).toMatch(/1000/);
  }, 600_000);

  it('answers a detail question from context without rerunning the task', async () => {
    const n = tasks().length;
    await tm.submit('Explain the changes in more detail.', 'voice');
    await until(() => tasks().length > n && finished(tasks()[n]), 200_000, 'detail answer');
    const t = tasks()[n];
    console.log('\nDETAIL ANSWER\n' + t.finalText);
    expect(t.state).toBe('completed');
    expect(t.evidence.commands.filter((c) => c.isTest)).toHaveLength(0);
    expect(t.evidence.files).toHaveLength(0);
  }, 300_000);

  it('cancels a running task and confirms it from the agent', async () => {
    const n = tasks().length;
    await tm.submit('Run this exact shell command and wait for it to finish: node -e "setTimeout(() => {}, 120000)"', 'keyboard');
    await until(() => tasks()[n]?.evidence.commands.length > 0 || tasks()[n]?.state === 'awaiting_input', 180_000, 'long command to start');
    await until(() => tasks()[n].state === 'running', 30_000, 'command running');
    await new Promise((r) => setTimeout(r, 3000));
    const started = Date.now();
    await tm.submit('Stop.', 'voice');
    await until(() => finished(tasks()[n]), 60_000, 'cancellation');
    console.log(`cancelled in ${Date.now() - started} ms; state=${tasks()[n].state}`);
    expect(tasks()[n].state).toBe('cancelled');
  }, 300_000);
});
