import { describe, expect, it } from 'vitest';
import { routeUtterance } from '../../src/core/intentRouter';

const busy = { hasActiveTask: true, hasFinishedTask: false };
const idle = { hasActiveTask: false, hasFinishedTask: true };
const kind = (s: string, ctx = busy) => routeUtterance(s, ctx).kind;

describe('routeUtterance while a task is running', () => {
  it.each([
    'Also check whether the fix affects password resets.',
    "While you're at it, update the README.",
    'And also run the linter',
    'Add this: log failed logins',
    'Check the signup page too',
  ])('treats "%s" as add', (s) => expect(kind(s)).toBe('add'));

  it.each(['Actually, the config is in settings.ts', 'By the way, we use Postgres not MySQL', 'FYI the tests need Node 20'])(
    'treats "%s" as clarify',
    (s) => expect(kind(s)).toBe('clarify'),
  );

  it.each(['Stop', 'cancel', 'Stop the task', 'okay stop it now', 'Cancel that please', 'never mind, stop', 'pause'])(
    'treats "%s" as stop',
    (s) => expect(kind(s)).toBe('stop'),
  );

  it('does not stop on an instruction that starts with "stop"', () => {
    const r = routeUtterance('Stop using var in the auth module', busy);
    expect(r.kind).toBe('ask');
  });

  it('does not stop on a negated stop', () => {
    expect(kind("don't stop, also check the logs")).toBe('add');
  });

  it.each(['Focus on the password reset first', 'Handle the login bug first', 'prioritise the failing tests'])(
    'treats "%s" as prioritise',
    (s) => expect(kind(s)).toBe('prioritise'),
  );

  it.each(['After that, write release notes', 'As a separate task, bump the version', "When you're done, refactor the API client"])(
    'treats "%s" as separate',
    (s) => expect(kind(s)).toBe('separate'),
  );

  it.each(["What's the status", "how's it going", 'what are you doing'])('treats "%s" as status', (s) => expect(kind(s)).toBe('status'));

  it('asks rather than guesses on an unmarked instruction', () => {
    const r = routeUtterance('Rename the user table', busy);
    expect(r.kind).toBe('ask');
    if (r.kind === 'ask') expect(r.options.map((o) => o.value)).toEqual(['add', 'separate', 'replace']);
  });
});

describe('routeUtterance when idle', () => {
  it('starts a new task', () => expect(kind('Fix the login bug', idle)).toBe('new'));
  it('even for "also" phrasing', () => expect(kind('Also fix the login bug', idle)).toBe('new'));
  it('routes detail questions about finished work', () => {
    expect(kind('Explain the changes in more detail', idle)).toBe('detail');
    expect(kind('Why did that test fail?', idle)).toBe('detail');
    expect(kind('Show me the code you changed', idle)).toBe('detail');
  });
  it('does not treat "stop" as cancellation with nothing running', () => expect(kind('stop', idle)).toBe('new'));
});
