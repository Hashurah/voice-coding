// Claude adapter against a scripted stand-in for the Agent SDK's query().
import { describe, expect, it } from 'vitest';
import { bashExitCode, ClaudeAdapter, describeTool } from '../../src/adapters/claudeAdapter';
import type { AgentEvent } from '../../src/shared/types';

type Msg = Record<string, unknown>;
const log = { write: () => {} };

/**
 * A fake query(): reads the input stream like the CLI does, and plays a script.
 * Script steps can wait for a follow-up to arrive or for a tool decision.
 */
function fakeQuery(script: (io: { emit: (m: Msg) => void; inputs: Msg[]; nextInput: () => Promise<Msg>; ask: (tool: string, input: Record<string, unknown>) => Promise<unknown>; interrupted: () => boolean }) => Promise<void>) {
  return ((params: { prompt: AsyncIterable<Msg>; options: { canUseTool: (n: string, i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown> } }) => {
    const queue: Msg[] = [];
    const waiters: ((m: Msg) => void)[] = [];
    const out: Msg[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let interrupted = false;
    const inputs: Msg[] = [];
    void (async () => {
      for await (const m of params.prompt) {
        inputs.push(m);
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      }
    })();
    const emit = (m: Msg) => {
      out.push(m);
      wake?.();
    };
    void script({
      emit,
      inputs,
      nextInput: () => new Promise((r) => (queue.length ? r(queue.shift()!) : waiters.push(r))),
      ask: (tool, input) => params.options.canUseTool(tool, input, { signal: new AbortController().signal }),
      interrupted: () => interrupted,
    }).finally(() => {
      done = true;
      wake?.();
    });
    const iter = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (out.length) yield out.shift()!;
          else if (done) return;
          else await new Promise<void>((r) => (wake = r));
        }
      },
      interrupt: async () => {
        interrupted = true;
        emit({ type: 'result', subtype: 'error_during_execution', errors: ['interrupted'] });
      },
      close: () => {},
    };
    return iter;
  }) as never;
}

const init = { type: 'system', subtype: 'init', session_id: 'sess-1' };
const assistant = (content: unknown[], extra: Msg = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { content }, ...extra });
const toolResult = (id: string, content: string, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

async function run(adapter: ClaudeAdapter, onEvent?: (e: AgentEvent, all: AgentEvent[]) => void) {
  const events: AgentEvent[] = [];
  await adapter.start({ taskId: 't1', prompt: 'Fix the bug', cwd: process.cwd() }, (_id, e) => {
    events.push(e);
    onEvent?.(e, events);
  });
  return events;
}

describe('ClaudeAdapter', () => {
  it('maps tools, commands with exit codes, file changes and the result', async () => {
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput, ask }) => {
        await nextInput();
        emit(init);
        emit(assistant([{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }]));
        await ask('Bash', { command: 'npm test' });
        emit(toolResult('b1', 'Exit code 1\nTests  1 failed | 2 passed (3)', true));
        emit(assistant([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'package.json', old_string: 'a', new_string: 'b' } }]));
        await ask('Edit', { file_path: 'package.json' });
        emit(toolResult('e1', 'ok'));
        emit({ type: 'result', subtype: 'success', result: 'Fixed it. Tests pass.' });
      }),
    });
    const events = await run(adapter, (e) => {
      if (e.kind === 'approval_request') adapter.respondToApproval(e.approvalId, 'allow');
    });
    expect(events.find((e) => e.kind === 'session')).toEqual({ kind: 'session', sessionId: 'sess-1' });
    expect(events.filter((e) => e.kind === 'command').at(-1)).toMatchObject({ command: 'npm test', exitCode: 1 });
    expect(events.find((e) => e.kind === 'file_change')).toEqual({ kind: 'file_change', path: 'package.json', change: 'edit' });
    expect(events.filter((e) => e.kind === 'approval_request')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ kind: 'done', outcome: 'success', finalText: 'Fixed it. Tests pass.' });
  });

  it('reports a follow-up as accepted only when Claude stamps a reply with its id', async () => {
    let followUpId = '';
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput }) => {
        await nextInput();
        emit(init);
        emit(assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }]));
        const f = await nextInput(); // the follow-up arrives mid-task
        expect(f.priority).toBe('next');
        followUpId = String(f.uuid);
        emit(toolResult('r1', 'contents'));
        emit(assistant([{ type: 'text', text: 'Also checking resets.' }], { user_message_uuid: f.uuid }));
        emit({ type: 'result', subtype: 'success', result: 'Done, including resets.' });
      }),
    });
    const events = await run(adapter, (e) => {
      if (e.kind === 'tool_call') void adapter.sendFollowUp('t1', 'fu-1', 'Also check password resets').then((r) => expect(r.status).toBe('queued'));
    });
    expect(followUpId).toBe('fu-1');
    expect(events.find((e) => e.kind === 'followup_status')).toMatchObject({ followUpId: 'fu-1', status: 'accepted' });
    expect(events.at(-1)).toMatchObject({ kind: 'done', outcome: 'success' });
  });

  it('waits for a further turn when a follow-up was not folded into the first one', async () => {
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput }) => {
        await nextInput();
        emit(init);
        emit(assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }]));
        const f = await nextInput();
        emit(toolResult('r1', 'x'));
        emit({ type: 'result', subtype: 'success', result: 'First part done.' });
        emit(assistant([{ type: 'text', text: 'Now the follow-up.' }], { user_message_uuid: f.uuid }));
        emit({ type: 'result', subtype: 'success', result: 'Follow-up done.', user_message_uuids: [f.uuid] });
      }),
    });
    const events = await run(adapter, (e) => {
      if (e.kind === 'tool_call') void adapter.sendFollowUp('t1', 'fu-2', 'Also update docs');
    });
    const dones = events.filter((e) => e.kind === 'done');
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ outcome: 'success', finalText: 'Follow-up done.' });
  });

  it('returns a denial to Claude without bypassing anything', async () => {
    let decision: unknown;
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput, ask }) => {
        await nextInput();
        emit(init);
        decision = await ask('Bash', { command: 'rm -rf build' });
        emit({ type: 'result', subtype: 'success', result: 'You declined, so I stopped.' });
      }),
    });
    const events = await run(adapter, (e) => {
      if (e.kind === 'approval_request') {
        expect(e.description).toBe('Run: rm -rf build');
        adapter.respondToApproval(e.approvalId, 'deny');
      }
    });
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(events.find((e) => e.kind === 'approval_resolved')).toMatchObject({ decision: 'deny' });
  });

  it('confirms cancellation from the terminal result', async () => {
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput, interrupted }) => {
        await nextInput();
        emit(init);
        emit(assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 100' } }]));
        while (!interrupted()) await new Promise((r) => setTimeout(r, 5));
      }),
    });
    const events = await run(adapter, (e) => {
      if (e.kind === 'tool_call') void adapter.interrupt('t1').then((r) => expect(r.ok).toBe(true));
    });
    expect(events.at(-1)).toMatchObject({ kind: 'done', outcome: 'cancelled' });
  });

  it('turns SDK errors into a failed task with a useful message', async () => {
    const adapter = new ClaudeAdapter(log, {
      queryFn: (() => {
        throw new Error('spawn claude ENOENT');
      }) as never,
    });
    const events = await run(adapter);
    expect(events.at(-1)).toMatchObject({ kind: 'done', outcome: 'error' });
    expect((events.at(-1) as { error: string }).error).toMatch(/could not be started/);
  });

  it('declines AskUserQuestion so the question comes back as text', async () => {
    let decision: unknown;
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput, ask }) => {
        await nextInput();
        emit(init);
        decision = await ask('AskUserQuestion', { questions: [] });
        emit({ type: 'result', subtype: 'success', result: 'Which file?' });
      }),
    });
    await run(adapter);
    expect(decision).toMatchObject({ behavior: 'deny' });
  });
});

describe('helpers', () => {
  it('reads exit codes from Bash results', () => {
    expect(bashExitCode(false, 'Exit code 2\nboom')).toBe(2);
    expect(bashExitCode(true, 'ok')).toBe(0);
    expect(bashExitCode(false, 'error without code')).toBe(1);
  });
  it('describes tools for approval prompts', () => {
    expect(describeTool('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, process.cwd())).toMatchObject({ description: expect.stringContaining('a.ts'), detail: '- x\n+ y' });
  });
});

describe('PowerShell on Windows', () => {
  it('treats the PowerShell tool as a command with an exit code', async () => {
    const adapter = new ClaudeAdapter(log, {
      queryFn: fakeQuery(async ({ emit, nextInput }) => {
        await nextInput();
        emit(init);
        emit(assistant([{ type: 'tool_use', id: 'p1', name: 'PowerShell', input: { command: 'npm test', description: 'Run tests' } }]));
        emit(toolResult('p1', '# tests 2\n# pass 2\n# fail 0'));
        emit({ type: 'result', subtype: 'success', result: 'Done.' });
      }),
    });
    const events = await run(adapter);
    expect(events.filter((e) => e.kind === 'command').at(-1)).toMatchObject({ command: 'npm test', exitCode: 0 });
    expect(describeTool('PowerShell', { command: 'npm test' }, process.cwd()).description).toBe('Run: npm test');
  });
});

describe('denied commands', () => {
  it('are recorded as not run, never as a failed run', async () => {
    const adapter = new ClaudeAdapter(log, {
      queryFn: (fakeQuery(async ({ emit, nextInput }) => {
        await nextInput();
        emit(init);
        emit(assistant([{ type: 'tool_use', id: 'b9', name: 'Bash', input: { command: 'npm test' } }]));
        emit(toolResult('b9', 'Permission to use Bash has been denied.', true));
        emit({ type: 'result', subtype: 'success', result: 'Could not run tests.' });
      }) as unknown as (p: { options: { canUseTool: (n: string, i: unknown, o: unknown) => Promise<unknown> } }) => unknown) as never,
    });
    // Simulate the CLI asking permission for b9 before the denied result arrives.
    const orig = (adapter as unknown as { opts: { queryFn: (p: { options: { canUseTool: (n: string, i: unknown, o: unknown) => Promise<unknown> } }) => unknown } }).opts;
    const realQuery = orig.queryFn;
    orig.queryFn = (p) => {
      void p.options.canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'b9' });
      return realQuery(p);
    };
    const events = await run(adapter, (e) => {
      if (e.kind === 'approval_request') adapter.respondToApproval(e.approvalId, 'deny');
    });
    const cmds = events.filter((e) => e.kind === 'command');
    expect(cmds.every((c) => (c as { exitCode?: number }).exitCode === undefined)).toBe(true);
    expect(cmds.at(-1)).toMatchObject({ output: expect.stringMatching(/^Not run/) });
  });
});

describe('error explanations', () => {
  it('distinguishes network, sign-in and missing-install failures', async () => {
    const msgFor = async (err: string) => {
      const a = new ClaudeAdapter(log, { queryFn: (() => { throw new Error(err); }) as never });
      const ev = await run(a);
      return (ev.at(-1) as { error: string }).error;
    };
    expect(await msgFor('fetch failed: ECONNREFUSED')).toMatch(/Network or service problem/);
    expect(await msgFor('401 invalid credentials')).toMatch(/not signed in/);
    expect(await msgFor('spawn claude ENOENT')).toMatch(/could not be started/);
  });
});
