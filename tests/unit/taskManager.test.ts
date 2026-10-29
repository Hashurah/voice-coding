import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DemoAdapter } from '../../src/adapters/demoAdapter';
import { TaskManager } from '../../src/core/taskManager';
import { TranscriptStore } from '../../src/core/transcriptStore';
import type { AgentAdapter, Settings, TaskInfo, UiEvent } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/types';

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function setup(adapter: AgentAdapter = new DemoAdapter({ speed: 0.01, askApproval: false }), settings: Partial<Settings> = {}) {
  const events: UiEvent[] = [];
  const s: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const tm = new TaskManager({ adapters: { demo: adapter }, emit: (e) => events.push(e), settings: () => s, cancelTimeoutMs: 500 });
  const said = () => events.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text);
  const tasks = () => [...tm.tasks.values()];
  const done = (t?: TaskInfo) => !!t && ['completed', 'partial', 'failed', 'cancelled'].includes(t.state);
  return { tm, events, said, tasks, done, settings: s };
}

describe('TaskManager with the demo agent', () => {
  it('runs a spoken task to completion with evidence and a spoken summary', async () => {
    const { tm, said, tasks, done } = setup();
    await tm.submit('Analyse my authentication system, fix the bug and run the tests', 'voice');
    await until(() => done(tasks()[0]));
    const t = tasks()[0];
    expect(t.state).toBe('completed');
    expect(t.report?.passed).toHaveLength(1);
    expect(t.evidence.files.map((f) => f.path)).toContain('src/auth/session.ts');
    expect(said()[0]).toMatch(/look into|On it|starting|looking/);
    expect(said().at(-1)).toMatch(/finished.*passed/);
    expect(tm.entries.some((e) => e.type === 'report')).toBe(true);
  });

  it('adds a follow-up to the running task without restarting it, and confirms it', async () => {
    const { tm, said, tasks, done } = setup(new DemoAdapter({ speed: 0.05, askApproval: false }));
    await tm.submit('Fix the auth bug and run the tests', 'voice');
    await until(() => tm.activeTask?.state === 'running');
    await tm.submit('Also check whether the fix affects password resets.', 'voice');
    expect(tasks()).toHaveLength(1);
    const f = tasks()[0].followUps[0];
    expect(f.kind).toBe('add');
    expect(said().some((s) => /passed that on|sent that/.test(s))).toBe(true);
    await until(() => done(tasks()[0]));
    expect(tasks()[0].followUps[0].status).toBe('accepted');
    expect(tasks()[0].state).toBe('completed');
    expect(tm.entries.some((e) => e.type === 'tool' && /password resets/.test(e.summary))).toBe(true);
  });

  it('asks instead of guessing, then applies the answer', async () => {
    const { tm, tasks, events, done } = setup(new DemoAdapter({ speed: 0.05, askApproval: false }));
    await tm.submit('Fix the auth bug', 'keyboard');
    await until(() => tm.activeTask?.state === 'running');
    await tm.submit('Rename the user table', 'voice');
    expect(tm.pendingQuestion).toBeDefined();
    await tm.submit('Separate task please', 'voice');
    expect(tm.pendingQuestion).toBeUndefined();
    expect(tasks()).toHaveLength(2);
    expect(tasks()[1].state).toBe('queued');
    await until(() => tasks().every(done), 10000);
    expect(tasks().map((t) => t.state)).toEqual(['completed', 'completed']);
    expect(events.some((e) => e.type === 'question' && e.question === null)).toBe(true);
  });

  it('cancels only on an explicit stop and reports the real result', async () => {
    const { tm, said, tasks, done } = setup(new DemoAdapter({ speed: 0.2, askApproval: false }));
    await tm.submit('Fix the auth bug', 'voice');
    await until(() => tm.activeTask?.state === 'running');
    await tm.submit('Stop', 'voice');
    await until(() => done(tasks()[0]));
    expect(tasks()[0].state).toBe('cancelled');
    expect(tasks()[0].report?.outcome).toBe('cancelled');
    expect(said().some((s) => /cancelled/.test(s))).toBe(true);
  });

  it('removes a queued task without touching the running one', async () => {
    const { tm, tasks } = setup(new DemoAdapter({ speed: 0.2, askApproval: false }));
    await tm.submit('Fix the auth bug', 'keyboard');
    await tm.submit('After that, update the changelog', 'keyboard');
    const queued = tasks()[1];
    const r = await tm.cancel(queued.id);
    expect(r.ok).toBe(true);
    expect(tasks()[1].state).toBe('cancelled');
    expect(tm.activeTask?.id).toBe(tasks()[0].id);
    await tm.cancel(tasks()[0].id);
  });

  it('holds the task for approval and refuses voice approval by default', async () => {
    const { tm, said, tasks, done } = setup(new DemoAdapter({ speed: 0.01, askApproval: true }));
    await tm.submit('Fix the auth bug', 'voice');
    await until(() => tm.activeTask?.state === 'awaiting_input');
    await tm.submit('approve', 'voice');
    expect(tm.activeTask?.state).toBe('awaiting_input');
    expect(said().at(-1)).toMatch(/click or the keyboard/);
    const approval = tasks()[0].evidence.approvals[0];
    tm.approve(approval.id, 'allow');
    await until(() => done(tasks()[0]));
    expect(tasks()[0].state).toBe('completed');
    expect(tasks()[0].evidence.approvals[0].decision).toBe('allow');
  });

  it('reports partial completion when an approval is denied', async () => {
    const { tm, tasks, done } = setup(new DemoAdapter({ speed: 0.01, askApproval: true }));
    await tm.submit('Fix the auth bug', 'keyboard');
    await until(() => tm.activeTask?.state === 'awaiting_input');
    await tm.submit('deny', 'keyboard');
    await until(() => done(tasks()[0]));
    expect(tasks()[0].state).toBe('partial');
  });

  it('marks a task failed when the adapter crashes', async () => {
    const broken = new DemoAdapter();
    broken.start = async () => {
      throw new Error('spawn claude ENOENT');
    };
    const { tm, tasks, done } = setup(broken);
    await tm.submit('Fix it', 'keyboard');
    await until(() => done(tasks()[0]));
    expect(tasks()[0].state).toBe('failed');
    expect(tasks()[0].error).toContain('ENOENT');
  });

  it('holds follow-ups for agents that cannot take them mid-task and sends them afterwards', async () => {
    const demo = new DemoAdapter({ speed: 0.05, askApproval: false });
    Object.defineProperty(demo, 'capabilities', { value: { ...demo.capabilities, midTaskInput: 'none' } });
    const { tm, tasks, said, done } = setup(demo);
    await tm.submit('Fix the auth bug', 'keyboard');
    await until(() => tm.activeTask?.state === 'running');
    await tm.submit('Also check password resets', 'voice');
    expect(tasks()[0].followUps[0].status).toBe('pending');
    expect(said().some((s) => /hand it over|pass that on when/.test(s))).toBe(true);
    await until(() => tasks().length === 2 && done(tasks()[1]), 10000);
    expect(tasks()[1].prompt).toContain('check password resets');
    expect(tasks()[0].followUps[0].status).toBe('queued');
  });

  it('streams speech for conversational answers', async () => {
    const { tm, said, tasks, done } = setup();
    await tm.submit('Fix the auth bug', 'keyboard');
    await until(() => done(tasks()[0]));
    const before = said().length;
    await tm.submit('Explain the changes in more detail', 'voice');
    await until(() => done(tasks()[1]));
    const spoken = said().slice(before);
    expect(spoken.length).toBeGreaterThan(1);
    expect(tasks()[1].report).toBeUndefined();
  });
});

describe('TranscriptStore', () => {
  it('survives a crash mid-write and marks interrupted tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-'));
    const store = new TranscriptStore(dir, 'conv1');
    const { tm, tasks } = (() => {
      const s = { ...DEFAULT_SETTINGS };
      const tm = new TaskManager({ adapters: { demo: new DemoAdapter({ speed: 1, askApproval: false }) }, emit: () => {}, store, settings: () => s });
      return { tm, tasks: () => [...tm.tasks.values()] };
    })();
    await tm.submit('Fix the auth bug', 'keyboard');
    await until(() => tasks()[0]?.state === 'running');
    store.close();
    fs.appendFileSync(store.file, '{"type":"user","id":"x","te'); // torn write

    const loaded = new TranscriptStore(dir, 'conv1').load();
    expect(loaded.corruptLines).toBe(1);
    expect(loaded.interrupted).toHaveLength(1);
    expect(loaded.entries.some((e) => e.type === 'user' && e.text === 'Fix the auth bug')).toBe(true);

    const s = { ...DEFAULT_SETTINGS };
    const tm2 = new TaskManager({ adapters: {}, emit: () => {}, settings: () => s });
    tm2.restore(loaded.entries, loaded.tasks);
    expect([...tm2.tasks.values()][0].state).toBe('failed');
    expect(tm2.entries.at(-1)).toMatchObject({ type: 'system', level: 'warn' });
    await tm.shutdown();
    expect(TranscriptStore.latestId(dir)).toBe('conv1');
  });
});

describe('long responses', () => {
  it('keeps the full written answer but speaks only a short version', async () => {
    const long = `${'The refactor touches many modules. '.repeat(40)}\n\n\`\`\`ts\n${'const x = 1;\n'.repeat(300)}\`\`\`\n\nTypeError: boom\n    at a (src/a.ts:1:1)`;
    const adapter = new DemoAdapter();
    adapter.start = async (input, sink) => {
      sink(input.taskId, { kind: 'text', text: long });
      sink(input.taskId, { kind: 'done', outcome: 'success', finalText: long });
    };
    const { tm, said, tasks, done } = setup(adapter);
    await tm.submit('Explain the refactor?', 'keyboard');
    await until(() => done(tasks()[0]));
    const written = tm.entries.find((e) => e.type === 'agent_text') as { text: string };
    expect(written.text).toBe(long);
    const speech = said().slice(1).join(' ');
    expect(speech.length).toBeLessThan(400);
    expect(speech).not.toMatch(/const x|TypeError|src\/a\.ts/);
  });
});
