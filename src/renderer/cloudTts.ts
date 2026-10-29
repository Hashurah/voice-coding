import type { Api } from '../shared/types';
import type { TtsEngine } from './speechOut';

/** OpenAI voices. The text to speak is sent to OpenAI by the main process. */
export class OpenAiTts implements TtsEngine {
  readonly name = 'openai';
  readonly local = false;
  private ctx: AudioContext | null = null;
  private cache = new Map<string, Promise<ArrayBuffer>>();

  constructor(private api: Api) {}

  async voices() {
    return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((v) => ({ id: v, label: v }));
  }

  private fetchAudio(text: string, voice: string, rate: number): Promise<ArrayBuffer> {
    const key = `${voice}|${rate}|${text}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.api.cloudTts(text, voice, rate);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  prepare(text: string, opts: { rate: number; voice: string }): void {
    void this.fetchAudio(text, opts.voice || 'alloy', opts.rate).catch(() => undefined);
  }

  async speak(text: string, opts: { rate: number; volume: number; voice: string }, signal: AbortSignal): Promise<void> {
    const data = await this.fetchAudio(text, opts.voice || 'alloy', opts.rate);
    if (signal.aborted) return;
    this.ctx ??= new AudioContext();
    const buf = await this.ctx.decodeAudioData(data.slice(0));
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    gain.gain.value = opts.volume;
    src.buffer = buf;
    src.connect(gain).connect(this.ctx.destination);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      signal.addEventListener('abort', () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        resolve();
      });
      src.start();
    });
  }
}
