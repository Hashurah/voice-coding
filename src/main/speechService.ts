// Supervises the on-device speech utility process: request/response by id,
// timeouts, and an automatic restart if it crashes.

import { utilityProcess, type UtilityProcess } from 'electron';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Log = { write(level: 'info' | 'warn' | 'error', msg: string): void };

export class SpeechService {
  private proc: UtilityProcess | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private sttModel = '';
  private ttsLoaded = false;
  private crashes: number[] = [];

  constructor(private entry: string, private modelsDir: string, private log: Log) {}

  private spawn(): UtilityProcess {
    if (this.proc) return this.proc;
    const p = utilityProcess.fork(this.entry, [], { serviceName: 'Speech', env: { ...process.env, VCC_MODELS_DIR: this.modelsDir }, stdio: 'pipe' });
    p.stderr?.on('data', (d) => this.log.write('warn', `[speech] ${String(d).trim()}`));
    p.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const r = this.pending.get(m.id);
      if (!r) return;
      clearTimeout(r.timer);
      this.pending.delete(m.id);
      if (m.ok) r.resolve(m.result);
      else r.reject(new Error(m.error));
    });
    p.on('exit', (code) => {
      this.log.write(code === 0 ? 'info' : 'error', `Speech process exited (${code})`);
      this.proc = null;
      this.sttModel = '';
      this.ttsLoaded = false;
      for (const r of this.pending.values()) {
        clearTimeout(r.timer);
        r.reject(new Error('The speech engine stopped unexpectedly.'));
      }
      this.pending.clear();
      if (code !== 0) this.crashes.push(Date.now());
    });
    this.proc = p;
    return p;
  }

  private call<T>(msg: Record<string, unknown>, timeoutMs: number, transfer?: ArrayBuffer[]): Promise<T> {
    const recent = this.crashes.filter((t) => Date.now() - t < 60_000);
    if (recent.length >= 3) return Promise.reject(new Error('The speech engine keeps crashing; on-device speech is paused. See the log.'));
    const p = this.spawn();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The speech engine did not respond within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      void transfer;
      p.postMessage({ id, ...msg });
    });
  }

  /** Speech requests are safe to repeat, so one crash mid-request is retried on a fresh process. */
  private async retryOnCrash<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!/stopped unexpectedly/.test((err as Error).message)) throw err;
      this.log.write('warn', 'Retrying a speech request after the speech process crashed.');
      return fn();
    }
  }

  transcribe(model: string, audio: Float32Array): Promise<{ text: string; ms: number }> {
    const copy = audio.slice();
    return this.retryOnCrash(() => this.transcribeOnce(model, copy));
  }

  private async transcribeOnce(model: string, audio: Float32Array): Promise<{ text: string; ms: number }> {
    if (this.sttModel !== model) {
      const r = await this.call<{ ms: number }>({ type: 'load-stt', model }, 120_000);
      this.sttModel = model;
      this.log.write('info', `Loaded ${model} in ${r.ms} ms`);
    }
    return this.call({ type: 'stt', audio }, 60_000);
  }

  async preload(model: string): Promise<void> {
    if (this.sttModel === model) return;
    const r = await this.call<{ ms: number }>({ type: 'load-stt', model }, 120_000);
    this.sttModel = model;
    this.log.write('info', `Loaded ${model} in ${r.ms} ms`);
  }

  synthesize(text: string, voice: string, speed: number): Promise<{ samples: Float32Array; rate: number; ms: number }> {
    return this.retryOnCrash(() => this.synthesizeOnce(text, voice, speed));
  }

  private async synthesizeOnce(text: string, voice: string, speed: number): Promise<{ samples: Float32Array; rate: number; ms: number }> {
    if (!this.ttsLoaded) {
      const r = await this.call<{ ms: number }>({ type: 'load-tts' }, 120_000);
      this.ttsLoaded = true;
      this.log.write('info', `Loaded Kokoro in ${r.ms} ms`);
    }
    return this.call({ type: 'tts', text, voice, speed }, 120_000);
  }

  /** Simulates a crash of the speech process (automated tests only). */
  killForTest(): boolean {
    return this.proc?.kill() ?? false;
  }


  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
