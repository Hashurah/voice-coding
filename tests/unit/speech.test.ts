import { describe, expect, it } from 'vitest';
import { planSpeech, SentenceStream, toSpeakable } from '../../src/core/speechShaper';
import { cleanTranscript, looksUnfinished, silenceBudgetMs } from '../../src/core/turnDetector';

describe('toSpeakable', () => {
  it('drops code blocks, stack traces and diffs', () => {
    const md = [
      'I fixed the bug in `session.ts`.',
      '```ts',
      'if (payload.exp * 1000 < Date.now()) throw new Error("expired");',
      '```',
      'TypeError: x is undefined',
      '    at foo (src/a.ts:1:2)',
      '- old line',
      '+ new line',
      'The tests pass.',
    ].join('\n');
    const s = toSpeakable(md);
    expect(s).toContain('I fixed the bug in session.ts.');
    expect(s).toContain('The tests pass.');
    expect(s).not.toMatch(/payload|at foo|old line|new line/);
  });

  it('shortens long paths and links', () => {
    expect(toSpeakable('See C:/Users/me/project/src/auth/session.ts and https://example.com/x')).toBe('See session.ts and a link.');
  });

  it('turns list items and headings into sentences', () => {
    expect(toSpeakable('## Summary\n- Fixed expiry\n- Added a test')).toBe('Summary. Fixed expiry. Added a test.');
  });
});

describe('planSpeech', () => {
  it('caps the spoken length but reports truncation', () => {
    const plan = planSpeech('One. Two. Three. Four. Five.', 3);
    expect(plan.sentences).toEqual(['One.', 'Two.', 'Three.']);
    expect(plan.truncated).toBe(true);
  });
});

describe('SentenceStream', () => {
  it('emits complete sentences as text streams in', () => {
    const s = new SentenceStream();
    expect(s.push('The bug is in')).toEqual([]);
    expect(s.push(' the session code. It compares')).toEqual(['The bug is in the session code.']);
    expect(s.push(' seconds with milliseconds. ')).toEqual(['It compares seconds with milliseconds.']);
    expect(s.flush()).toEqual([]);
  });

  it('holds back text inside an unfinished code fence', () => {
    const s = new SentenceStream();
    expect(s.push('Here is the fix. ```ts\nconst a = 1. ')).toEqual([]);
    expect(s.push('```\nDone. ')).toEqual(['Here is the fix.', 'Done.']);
  });
});

describe('turn detection', () => {
  const cfg = { endOfTurnMs: 1400, hesitationExtraMs: 1600 };

  it.each(['Fix the login bug and', 'Check the, um', 'Look at the session code because', 'Update the config to', 'so,'])(
    'waits longer after an unfinished phrase: "%s"',
    (s) => {
      expect(looksUnfinished(s)).toBe(true);
      expect(silenceBudgetMs(s, cfg)).toBe(3000);
    },
  );

  it.each(['Fix the login bug.', 'Run the tests', 'Check the password reset flow'])('ends normally after a complete phrase: "%s"', (s) => {
    expect(looksUnfinished(s)).toBe(false);
    expect(silenceBudgetMs(s, cfg)).toBe(1400);
  });

  it('removes fillers and stutters', () => {
    expect(cleanTranscript('um fix the the login uh bug')).toBe('Fix the login bug');
  });

  it('keeps the corrected instruction after a self-correction', () => {
    expect(cleanTranscript('check the login page, no wait, check the signup page')).toBe('Check the signup page');
  });

  it('handles recogniser punctuation around the correction', () => {
    expect(cleanTranscript('Check the login page. No wait. Check the sign up page.')).toBe('Check the sign up page.');
  });

  it('keeps both parts when the correction is not a restatement', () => {
    expect(cleanTranscript('fix the bug, actually no, write a test first')).toMatch(/^Fix the bug.*write a test first$/);
  });
});
