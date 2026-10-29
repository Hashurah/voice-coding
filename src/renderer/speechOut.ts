// Spoken output: a queue of sentences played through one engine at a time.
// Barge-in (the user starting to talk) calls stop(), which cuts playback
// immediately and drops anything queued.

export interface TtsEngine {
  readonly name: string;
  readonly local: boolean;
  /** Speaks one chunk; resolves when finished or stopped. */
  speak(text: string, opts: { rate: number; volume: number; voice: string }, signal: AbortSignal): Promise<void>;
  /** Optional: synthesise ahead so the next sentence starts without a gap. */
  prepare?(text: string, opts: { rate: number; voice: string }): void;
  voices(): Promise<{ id: string; label: string }[]>;
}

/** Windows/macOS voices through the Web Speech synthesis API. No download. */
export class SystemTts implements TtsEngine {
  readonly name = 'system';
  readonly local = true;

  async voices() {
    const list = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const v = speechSynthesis.getVoices();
      if (v.length) return resolve(v);
      speechSynthesis.addEventListener('voiceschanged', () => resolve(speechSynthesis.getVoices()), { once: true });
      setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    });
    return list.filter((v) => v.lang.startsWith('en')).map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})` }));
  }

  speak(text: string, opts: { rate: number; volume: number; voice: string }, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === opts.voice);
      if (voice) u.voice = voice;
      u.rate = opts.rate;
      u.volume = opts.volume;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      signal.addEventListener('abort', () => {
        speechSynthesis.cancel();
        resolve();
      });
      speechSynthesis.speak(u);
    });
  }
}

type Item = { text: string; priority: 'ack' | 'summary' | 'alert' };

export class SpeechOut {
  private queue: Item[] = [];
  private current: AbortController | null = null;
  private running = false;
  enabled = true;
  rate = 1;
  volume = 0.9;
  voice = '';
  onState: (speaking: boolean) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor(public engine: TtsEngine, private fallback: TtsEngine) {}

  get speaking(): boolean {
    return this.running;
  }

  say(text: string, priority: Item['priority']): void {
    if (!this.enabled || !text.trim()) return;
    // A stale acknowledgement isn't worth saying once something else is queued.
    if (priority === 'alert') this.queue = this.queue.filter((q) => q.priority !== 'ack');
    if (priority === 'ack' && this.queue.length > 1) return;
    // Sentence by sentence, so speech starts sooner and the next one can be prepared while this one plays.
    const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
    for (const s of sentences) this.queue.push({ text: s, priority });
    void this.pump();
  }

  stop(): void {
    this.queue = [];
    this.current?.abort();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onState(true);
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        const next = this.queue[0];
        if (next) this.engine.prepare?.(next.text, { rate: this.rate, voice: this.voice });
        this.current = new AbortController();
        const opts = { rate: this.rate, volume: this.volume, voice: this.voice };
        try {
          await this.engine.speak(item.text, opts, this.current.signal);
        } catch (err) {
          this.onError(`${this.engine.name} voice failed (${(err as Error).message}); using the system voice.`);
          this.engine = this.fallback;
          if (!this.current.signal.aborted) await this.fallback.speak(item.text, { ...opts, voice: '' }, this.current.signal);
        }
      }
    } finally {
      this.current = null;
      this.running = false;
      this.onState(false);
    }
  }
}
