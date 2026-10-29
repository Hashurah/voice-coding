// On-device speech, in its own Electron utility process so a crash or a slow
// model never blocks the UI or the agent. Uses ONNX Runtime's native build.
// Models load only from the local models folder; remote downloads are off.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import * as path from 'node:path';

type Req =
  | { id: number; type: 'load-stt'; model: string }
  | { id: number; type: 'stt'; audio: Float32Array }
  | { id: number; type: 'load-tts' }
  | { id: number; type: 'tts'; text: string; voice: string; speed: number };

const port = (process as unknown as { parentPort: { on(e: 'message', cb: (m: { data: Req }) => void): void; postMessage(m: unknown, transfer?: unknown[]): void } }).parentPort;

env.localModelPath = (process.env.VCC_MODELS_DIR ?? '') + path.sep;
env.allowRemoteModels = false;
env.allowLocalModels = true;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let asrModel = '';
// kokoro-js is only loaded if the natural voice is used.
let tts: { generate(text: string, o: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>; voices: Record<string, unknown> } | null = null;

async function handle(m: Req): Promise<{ result: unknown; transfer?: unknown[] }> {
  switch (m.type) {
    case 'load-stt': {
      if (asr && asrModel === m.model) return { result: { ms: 0 } };
      const t = performance.now();
      await asr?.dispose();
      asr = (await pipeline('automatic-speech-recognition', m.model, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } })) as AutomaticSpeechRecognitionPipeline;
      asrModel = m.model;
      await asr(new Float32Array(1600)); // warm-up so the first real request is fast
      return { result: { ms: Math.round(performance.now() - t) } };
    }
    case 'stt': {
      if (!asr) throw new Error('No speech recognition model is loaded.');
      const t = performance.now();
      const long = m.audio.length / 16000 > 28 && asrModel.includes('whisper');
      const out = (await asr(m.audio, long ? { chunk_length_s: 30, stride_length_s: 5 } : {})) as { text: string };
      return { result: { text: out.text ?? '', ms: Math.round(performance.now() - t) } };
    }
    case 'load-tts': {
      const t = performance.now();
      if (!tts) {
        const { KokoroTTS } = await import('kokoro-js');
        tts = (await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })) as unknown as typeof tts;
      }
      return { result: { ms: Math.round(performance.now() - t) } };
    }
    case 'tts': {
      if (!tts) throw new Error('The natural voice is not loaded.');
      const t = performance.now();
      const voice = m.voice in tts.voices ? m.voice : 'af_heart';
      const a = await tts.generate(m.text, { voice, speed: m.speed });
      const samples = a.audio;
      return { result: { samples, rate: a.sampling_rate, ms: Math.round(performance.now() - t) }, transfer: [samples.buffer] };
    }
  }
}

// One request at a time: ONNX sessions already use all cores.
let chain = Promise.resolve();
port.on('message', ({ data }) => {
  chain = chain.then(async () => {
    try {
      const { result, transfer } = await handle(data);
      port.postMessage({ id: data.id, ok: true, result }, transfer);
    } catch (err) {
      port.postMessage({ id: data.id, ok: false, error: (err as Error).message ?? String(err) });
    }
  });
});
