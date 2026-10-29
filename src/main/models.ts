// Downloads the optional on-device speech models from Hugging Face into the
// app's data folder. Nothing is downloaded without the user asking (setup
// wizard or `npm run models`). After that, speech runs fully offline.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ModelPack {
  id: 'whisper-base' | 'whisper-tiny' | 'moonshine-base' | 'kokoro';
  label: string;
  repo: string;
  files: string[];
  approxMB: number;
  purpose: string;
}

const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

export const KOKORO_VOICE_FILES = ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable'];

export const MODEL_PACKS: ModelPack[] = [
  {
    id: 'whisper-base',
    label: 'Whisper base (English)',
    repo: 'onnx-community/whisper-base.en',
    files: WHISPER_FILES,
    approxMB: 80,
    purpose: 'Speech recognition on this computer. Recommended.',
  },
  {
    id: 'moonshine-base',
    label: 'Moonshine base (English)',
    repo: 'onnx-community/moonshine-base-ONNX',
    files: WHISPER_FILES,
    approxMB: 65,
    purpose: 'Fast speech recognition for short spoken instructions.',
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper tiny (English)',
    repo: 'onnx-community/whisper-tiny.en',
    files: WHISPER_FILES,
    approxMB: 45,
    purpose: 'Faster, less accurate speech recognition for slow computers.',
  },
  {
    id: 'kokoro',
    label: 'Kokoro natural voice',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', ...KOKORO_VOICE_FILES.map((v) => `voices/${v}.bin`)],
    approxMB: 96,
    purpose: 'Natural-sounding spoken replies on this computer.',
  },
];

export function packDir(modelsDir: string, pack: ModelPack): string {
  return path.join(modelsDir, ...pack.repo.split('/'));
}

export function isInstalled(modelsDir: string, pack: ModelPack): boolean {
  const dir = packDir(modelsDir, pack);
  return pack.files.every((f) => fs.existsSync(path.join(dir, f)));
}

export interface Progress {
  pack: ModelPack['id'];
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number;
}

/** Downloads missing files. Each file is written to .part and renamed when complete. */
export async function downloadPack(
  modelsDir: string,
  pack: ModelPack,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const dir = packDir(modelsDir, pack);
  for (const [i, file] of pack.files.entries()) {
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const url = `https://huggingface.co/${pack.repo}/resolve/main/${file}`;
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Download failed for ${file}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const part = `${dest}.part`;
    const out = fs.createWriteStream(part);
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress({ pack: pack.id, file, fileIndex: i, fileCount: pack.files.length, received, total });
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw err;
    }
    if (total && received !== total) {
      fs.rmSync(part, { force: true });
      throw new Error(`Incomplete download for ${file} (${received} of ${total} bytes).`);
    }
    fs.renameSync(part, dest);
  }
}
