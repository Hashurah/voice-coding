import type { Api } from '../shared/types';
import type { TtsEngine } from './speechOut';

export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'af_nicole', label: 'Nicole (US, female, soft)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'am_puck', label: 'Puck (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
  { id: 'bm_fable', label: 'Fable (UK, male)' },
];

/** Natural on-device voice. Synthesis runs in the speech process; playback through Web Audio. */
export class KokoroTts implements TtsEngine {
  readonly name = 'kokoro';
  readonly local = true;
  private static instance: KokoroTts | null = null;
  private cache = new Map<string, Promise<{ samples: Float32Array; rate: number }>>();
  private ctx: AudioContext | null = null;
  /** Measured real-time factor (synthesis time / audio duration). */
  rtf = 0;

  static shared(api: Api): KokoroTts {
    return (KokoroTts.instance ??= new KokoroTts(api));
  }

  private constructor(private api: Api) {}

  async isInstalled(): Promise<boolean> {
    return (await this.api.modelStatus()).some((m) => m.id === 'kokoro' && m.installed);
  }

  async voices() {
    return KOKORO_VOICES;
  }

  private synth(text: string, voice: string, speed: number): Promise<{ samples: Float32Array; rate: number }> {
    const key = `${voice}|${speed}|${text}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.api.synthesize(text, voice, speed).then((r) => {
        this.rtf = r.ms / 1000 / Math.max(0.1, r.samples.length / r.rate);
        return r;
      });
      this.cache.set(key, p);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  prepare(text: string, opts: { rate: number; voice: string }): void {
    void this.synth(text, opts.voice || 'af_heart', opts.rate).catch(() => undefined);
  }

  async speak(text: string, opts: { rate: number; volume: number; voice: string }, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const { samples, rate } = await this.synth(text, opts.voice || 'af_heart', opts.rate);
    this.cache.delete(`${opts.voice || 'af_heart'}|${opts.rate}|${text}`);
    if (signal.aborted) return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const buf = this.ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
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
