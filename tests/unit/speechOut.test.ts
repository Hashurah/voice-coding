import { describe, expect, it } from 'vitest';
import { SpeechOut, type TtsEngine } from '../../src/renderer/speechOut';

function fakeEngine(ms = 50) {
  const spoken: string[] = [];
  const aborted: string[] = [];
  const engine: TtsEngine = {
    name: 'fake',
    local: true,
    voices: async () => [],
    speak: (text, _o, signal) =>
      new Promise<void>((resolve) => {
        spoken.push(text);
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          aborted.push(text);
          resolve();
        });
      }),
  };
  return { engine, spoken, aborted };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SpeechOut', () => {
  it('speaks sentence by sentence and stops immediately on barge-in', async () => {
    const { engine, spoken, aborted } = fakeEngine(100);
    const out = new SpeechOut(engine, engine);
    out.say('First sentence. Second sentence. Third sentence.', 'summary');
    await tick(20);
    expect(out.speaking).toBe(true);
    out.stop(); // the user started talking
    await tick(20);
    expect(aborted).toEqual(['First sentence.']);
    expect(spoken).toEqual(['First sentence.']);
    expect(out.speaking).toBe(false);
  });

  it('never plays two things at once', async () => {
    let concurrent = 0;
    let max = 0;
    const engine: TtsEngine = {
      name: 'fake',
      local: true,
      voices: async () => [],
      speak: async () => {
        concurrent++;
        max = Math.max(max, concurrent);
        await tick(10);
        concurrent--;
      },
    };
    const out = new SpeechOut(engine, engine);
    out.say('One. Two.', 'summary');
    out.say('Three.', 'alert');
    out.say('Four.', 'summary');
    await tick(100);
    expect(max).toBe(1);
  });

  it('drops stale acknowledgements when an alert arrives', async () => {
    const { engine, spoken } = fakeEngine(30);
    const out = new SpeechOut(engine, engine);
    out.say('Working on it.', 'summary');
    out.say('Got it.', 'ack');
    out.say('I need your approval.', 'alert');
    await tick(150);
    expect(spoken).toEqual(['Working on it.', 'I need your approval.']);
  });

  it('falls back to the system voice when the engine fails', async () => {
    const broken: TtsEngine = { name: 'kokoro', local: true, voices: async () => [], speak: async () => Promise.reject(new Error('model missing')) };
    const { engine: fallback, spoken } = fakeEngine(5);
    const out = new SpeechOut(broken, fallback);
    const errors: string[] = [];
    out.onError = (m) => errors.push(m);
    out.say('Hello there.', 'summary');
    await tick(50);
    expect(spoken).toEqual(['Hello there.']);
    expect(errors[0]).toMatch(/kokoro voice failed/);
  });

  it('says nothing when muted', async () => {
    const { engine, spoken } = fakeEngine(5);
    const out = new SpeechOut(engine, engine);
    out.enabled = false;
    out.say('Hello.', 'alert');
    await tick(20);
    expect(spoken).toEqual([]);
  });
});
