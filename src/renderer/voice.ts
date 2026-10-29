// Microphone → voice activity detection (Silero) → speech recognition
// (Moonshine/Whisper in the native speech process, or OpenAI if chosen) → TurnAssembler → callbacks.

import { MicVAD } from '@ricky0123/vad-web';
import type { Api, Settings } from '../shared/types';
import { reliableText, TurnAssembler, VAD_REDEMPTION_MS, type TurnState } from '../core/turnAssembler';

export type VoiceState = TurnState | 'starting' | 'error';

export interface VoiceDeps {
  api: Api;
  settings: () => Settings;
  onState(s: VoiceState): void;
  onPartial(text: string): void;
  onReview(text: string, msLeft: number): void;
  onFinal(text: string): void;
  onDiscard(reason: string): void;
  onSpeechStart(): void;
  onError(msg: string): void;
  onInfo(msg: string): void;
  isSpeaking(): boolean;
}

export interface VoiceController {
  pttDown(): Promise<void>;
  pttUp(): void;
  setContinuous(on: boolean): Promise<void>;
  discard(): void;
  sendNow(): void;
  stats(): { lastSttMs: number; sttLoadMs: number };
}


function micErrorMessage(err: unknown): string {
  const e = err as DOMException;
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was refused. On Windows, open Settings → Privacy & security → Microphone and allow desktop apps, then try again. You can keep typing meanwhile.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Plug one in and try again, or type instead.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or failed to start (another app may be using it). Try again, or type instead.';
    default:
      return `The microphone could not start: ${e?.message ?? String(err)}`;
  }
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

/** 16-bit mono WAV, for the cloud recogniser. */
function toWav(samples: Float32Array, rate = 16000): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buf;
}

class Recogniser {
  private loading: Promise<void> | null = null;
  lastMs = 0;
  loadMs = 0;

  constructor(private deps: VoiceDeps) {}

  /** Warms up the on-device model so the first utterance isn't slow. */
  load(): Promise<void> {
    if (this.deps.settings().sttEngine === 'openai') return Promise.resolve();
    this.loading ??= (async () => {
      const t = performance.now();
      const r = await this.deps.api.preloadSpeech();
      if (!r.ok) {
        this.loading = null;
        throw new Error(r.error);
      }
      this.loadMs = Math.round(performance.now() - t);
    })();
    return this.loading;
  }

  async transcribe(audio: Float32Array): Promise<string> {
    const t = performance.now();
    if (this.deps.settings().sttEngine === 'openai') {
      const text = await this.deps.api.cloudStt(toWav(audio), 'audio/wav');
      this.lastMs = Math.round(performance.now() - t);
      return text;
    }
    const r = await this.deps.api.transcribe(audio);
    this.lastMs = r.ms;
    return r.text;
  }
}

export function createVoice(deps: VoiceDeps): VoiceController {
  const stt = new Recogniser(deps);
  let vad: MicVAD | null = null;
  let starting: Promise<MicVAD | null> | null = null;
  let mode: 'ptt' | 'continuous' | 'off' = 'off';
  let state: VoiceState = 'idle';
  let errored = false;

  const setState = (s: VoiceState) => {
    state = s;
    deps.onState(s);
  };

  const turn = new TurnAssembler(
    () => deps.settings(),
    {
      onState: (s) => {
        if (!errored) setState(s);
      },
      onPartial: deps.onPartial,
      onReview: deps.onReview,
      onFinal: deps.onFinal,
      onDiscard: deps.onDiscard,
    },
  );

  async function getStream(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      errored = true;
      setState('error');
      deps.onError('The microphone was disconnected. Reconnect it and press the mic button again, or keep typing.');
      void vad?.destroy().catch(() => undefined);
      vad = null;
      turn.discard('Microphone lost; that recording was discarded.');
    });
    return stream;
  }

  async function ensureVad(): Promise<MicVAD | null> {
    if (vad) return vad;
    if (starting) return starting;
    setState('starting');
    starting = (async () => {
      try {
        // Load the recogniser alongside the microphone so the first turn isn't slow.
        stt.load().catch((e) => deps.onError(`Speech recognition is unavailable: ${(e as Error).message}`));
        const v = await MicVAD.new({
          model: 'v5',
          baseAssetPath: 'app://ui/vendor/vad/',
          onnxWASMBasePath: 'app://ui/vendor/ort-vad/',
          startOnLoad: false,
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          redemptionMs: VAD_REDEMPTION_MS,
          preSpeechPadMs: 400,
          minSpeechMs: 250,
          submitUserSpeechOnPause: true,
          getStream,
          onSpeechStart: () => {
            turn.speechStart();
          },
          onSpeechRealStart: () => {
            // Interrupt the app's own speech only once it's clearly the user talking.
            if (deps.isSpeaking()) deps.onSpeechStart();
          },
          onVADMisfire: () => turn.misfire(),
          onSpeechEnd: (audio: Float32Array) => {
            const seq = turn.speechEnd();
            const seconds = audio.length / 16000;
            const level = rms(audio);
            stt
              .transcribe(audio)
              .then((text) => {
                const ok = reliableText(text, seconds, level);
                deps.api.logRenderer('info', `STT ${seconds.toFixed(1)}s audio in ${stt.lastMs} ms: ${ok === null ? `[unreliable: "${text.trim()}"]` : `"${ok}"`}`);
                turn.segmentText(seq, ok);
              })
              .catch((err) => {
                deps.onError(`Speech recognition failed: ${(err as Error).message}`);
                turn.segmentText(seq, null);
              });
          },
        });
        errored = false;
        vad = v;
        return v;
      } catch (err) {
        errored = true;
        setState('error');
        deps.onError(micErrorMessage(err));
        return null;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  /** Opening the microphone happens here (not when the VAD loads), so permission errors surface here. */
  async function startVad(v: MicVAD): Promise<boolean> {
    try {
      await v.start();
      if (v.errored) throw new Error(v.errored);
      return true;
    } catch (err) {
      errored = true;
      setState('error');
      deps.onError(micErrorMessage(err));
      turn.discard('');
      return false;
    }
  }

  const controller: VoiceController = {
    async pttDown() {
      if (mode === 'continuous') return;
      mode = 'ptt';
      const v = await ensureVad();
      if (!v || mode !== 'ptt') return;
      turn.begin('ptt');
      if (!(await startVad(v))) mode = 'off';
    },
    pttUp() {
      if (mode !== 'ptt') return;
      mode = 'off';
      if (!vad) return;
      // Pausing flushes any speech in progress through onSpeechEnd, then releases the mic.
      void vad.pause().then(() => turn.release());
    },
    async setContinuous(on) {
      if (on) {
        mode = 'continuous';
        const v = await ensureVad();
        if (!v) {
          mode = 'off';
          return;
        }
        turn.begin('continuous');
        if (!(await startVad(v))) {
          mode = 'off';
          return;
        }
        deps.onInfo('Continuous listening is on. Pause naturally; I send after a longer silence. Ctrl+M turns it off.');
      } else {
        mode = 'off';
        await vad?.pause();
        turn.stopListening();
      }
    },
    discard() {
      turn.discard();
    },
    sendNow() {
      turn.sendNow();
    },
    stats() {
      return { lastSttMs: stt.lastMs, sttLoadMs: stt.loadMs };
    },
  };
  void state;
  return controller;
}
