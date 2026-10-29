// Compares on-device recognisers on the WAV fixtures, trimmed to speech like the VAD would.
// Usage: node scripts/bench-stt.mjs [model ...]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';

env.localModelPath = (process.env.VCC_MODELS ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'voice-coding-companion', 'models')) + path.sep;
env.allowRemoteModels = false;

export function readWav16k(file) {
  const b = fs.readFileSync(file);
  for (let off = 12; off < b.length; ) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size;
  }
  throw new Error('no data chunk');
}
const trim = (a) => {
  let s = 0, e = a.length - 1;
  while (s < a.length && Math.abs(a[s]) < 0.01) s++;
  while (e > s && Math.abs(a[e]) < 0.01) e--;
  return a.slice(Math.max(0, s - 4800), Math.min(a.length, e + 4800));
};

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['onnx-community/moonshine-base-ONNX', 'onnx-community/whisper-base.en'];
for (const model of models) {
  const t0 = performance.now();
  const asr = await pipeline('automatic-speech-recognition', model, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
  console.log(`\n${model} load ${Math.round(performance.now() - t0)} ms`);
  for (const f of fs.readdirSync('tests/fixtures/audio').filter((x) => x.endsWith('.wav'))) {
    const audio = trim(readWav16k(path.join('tests/fixtures/audio', f)));
    await asr(audio.slice(0, 1600)); // warm-up
    const t = performance.now();
    const r = await asr(audio);
    console.log(`  ${f} (${(audio.length / 16000).toFixed(1)}s): ${Math.round(performance.now() - t)} ms → "${r.text.trim()}"`);
  }
}
