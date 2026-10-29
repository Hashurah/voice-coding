import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reliableText, TurnAssembler, type TurnState } from '../../src/core/turnAssembler';

function make(cfg = { endOfTurnMs: 1400, hesitationExtraMs: 1600, reviewWindowMs: 1000 }) {
  const log: { states: TurnState[]; finals: string[]; discards: string[]; partials: string[] } = { states: [], finals: [], discards: [], partials: [] };
  const t = new TurnAssembler(
    () => cfg,
    {
      onState: (s) => log.states.push(s),
      onPartial: (p) => log.partials.push(p),
      onReview: () => {},
      onFinal: (f) => log.finals.push(f),
      onDiscard: (d) => log.discards.push(d),
    },
    { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() },
  );
  /** One spoken segment whose transcription arrives immediately. */
  const say = (text: string | null) => {
    t.speechStart();
    t.segmentText(t.speechEnd(), text);
  };
  return { t, log, say };
}

beforeEach(() => vi.useFakeTimers());

describe('continuous listening', () => {
  it('does not submit during a natural pause after an unfinished phrase', () => {
    const { t, log, say } = make();
    t.begin('continuous');
    say('Fix the login bug and');
    vi.advanceTimersByTime(1500); // longer than the plain end-of-turn budget
    expect(log.finals).toEqual([]);
    say('then run the tests.');
    vi.advanceTimersByTime(800 + 1000 + 200);
    expect(log.finals).toEqual(['Fix the login bug and then run the tests.']);
  });

  it('ends the turn after a complete sentence and the configured silence', () => {
    const { t, log, say } = make();
    t.begin('continuous');
    say('Run the tests.');
    vi.advanceTimersByTime(799);
    expect(log.states.at(-1)).toBe('listening');
    vi.advanceTimersByTime(1);
    expect(log.states.at(-1)).toBe('reviewing');
    vi.advanceTimersByTime(1000);
    expect(log.finals).toEqual(['Run the tests.']);
  });

  it('counts silence from when speech stopped, not from when transcription finished', () => {
    const { t, log } = make({ endOfTurnMs: 1400, hesitationExtraMs: 0, reviewWindowMs: 0 });
    t.begin('continuous');
    t.speechStart();
    const seq = t.speechEnd();
    vi.advanceTimersByTime(1000); // slow recogniser
    t.segmentText(seq, 'Run the tests.');
    // 600 ms VAD wait + 1000 ms transcription already exceed the 1400 ms budget.
    vi.advanceTimersByTime(0);
    expect(log.finals).toEqual(['Run the tests.']);
  });

  it('keeps segments in spoken order when transcriptions finish out of order', () => {
    const { t, log } = make({ endOfTurnMs: 1000, hesitationExtraMs: 0, reviewWindowMs: 0 });
    t.begin('continuous');
    t.speechStart();
    const first = t.speechEnd();
    t.speechStart();
    const second = t.speechEnd();
    t.segmentText(second, 'then run the tests.');
    t.segmentText(first, 'Fix the login bug');
    vi.advanceTimersByTime(1000);
    expect(log.finals).toEqual(['Fix the login bug then run the tests.']);
  });

  it('resumes the same turn if the user speaks during review', () => {
    const { t, log, say } = make();
    t.begin('continuous');
    say('Check the reset flow.');
    vi.advanceTimersByTime(800 + 300);
    expect(log.states.at(-1)).toBe('reviewing');
    say('And the signup page.');
    vi.advanceTimersByTime(800 + 1000);
    expect(log.finals).toEqual(['Check the reset flow. And the signup page.']);
  });

  it('cleans fillers and self-corrections before sending', () => {
    const { t, log, say } = make({ endOfTurnMs: 1000, hesitationExtraMs: 0, reviewWindowMs: 0 });
    t.begin('continuous');
    say('Um, check the login page, no wait, check the signup page.');
    vi.advanceTimersByTime(1000);
    expect(log.finals).toEqual(['Check the signup page.']);
  });

  it('reports unreliable audio instead of guessing', () => {
    const { t, log, say } = make();
    t.begin('continuous');
    say(null);
    expect(log.finals).toEqual([]);
    expect(log.discards[0]).toMatch(/couldn't make that out/);
  });

  it('waits for an in-flight transcription before ending the turn', () => {
    const { t, log } = make({ endOfTurnMs: 1000, hesitationExtraMs: 0, reviewWindowMs: 0 });
    t.begin('continuous');
    t.speechStart();
    const a = t.speechEnd();
    t.speechStart();
    const b = t.speechEnd();
    t.segmentText(a, 'First part.');
    vi.advanceTimersByTime(5000);
    expect(log.finals).toEqual([]);
    t.segmentText(b, 'Second part.');
    vi.advanceTimersByTime(1000);
    expect(log.finals).toEqual(['First part. Second part.']);
  });
});

describe('push to talk', () => {
  it('ignores silence while held and sends on release', () => {
    const { t, log, say } = make({ endOfTurnMs: 1000, hesitationExtraMs: 0, reviewWindowMs: 0 });
    t.begin('ptt');
    say('Refactor the client');
    vi.advanceTimersByTime(10000);
    expect(log.finals).toEqual([]);
    t.release();
    expect(log.finals).toEqual(['Refactor the client']);
  });

  it('waits for the last segment when released mid-speech', () => {
    const { t, log } = make({ endOfTurnMs: 1000, hesitationExtraMs: 0, reviewWindowMs: 0 });
    t.begin('ptt');
    t.speechStart();
    t.release();
    expect(log.finals).toEqual([]);
    t.segmentText(t.speechEnd(), 'Add logging');
    expect(log.finals).toEqual(['Add logging']);
  });

  it('says so when nothing was heard', () => {
    const { t, log } = make();
    t.begin('ptt');
    t.release();
    expect(log.discards).toEqual(["I didn't hear anything."]);
  });

  it('can be discarded during review', () => {
    const { t, log, say } = make();
    t.begin('ptt');
    say('Delete the database');
    t.release();
    expect(t.discard()).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(log.finals).toEqual([]);
  });
});

describe('reliableText', () => {
  it('rejects silence, noise tags and known hallucinations', () => {
    expect(reliableText('[BLANK_AUDIO]', 2, 0.05)).toBeNull();
    expect(reliableText(' Thank you.', 0.8, 0.05)).toBeNull();
    expect(reliableText('Fix the bug', 2, 0.001)).toBeNull();
    expect(reliableText('the the the the the the', 3, 0.05)).toBeNull();
    expect(reliableText(' (keyboard clicking) Run the tests.', 2, 0.05)).toBe('Run the tests.');
    expect(reliableText('Thank you.', 2.5, 0.05)).toBe('Thank you.');
  });
});
