// Downloads on-device speech models without opening the app.
// Usage: npm run models -- [whisper-base] [whisper-tiny] [kokoro] [--dir <path>]
import { build } from 'esbuild';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const appData = process.env.APPDATA ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
const modelsDir = dirFlag >= 0 ? path.resolve(args[dirFlag + 1]) : path.join(appData, 'voice-coding-companion', 'models');
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir');

const out = path.join(os.tmpdir(), `vcc-models-${process.pid}.mjs`);
await build({ entryPoints: ['src/main/models.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const { MODEL_PACKS, downloadPack, isInstalled } = await import(pathToFileURL(out).href);

const packs = MODEL_PACKS.filter((p) => (wanted.length ? wanted.includes(p.id) : p.id !== 'whisper-tiny'));
console.log(`Models folder: ${modelsDir}`);
for (const pack of packs) {
  if (isInstalled(modelsDir, pack)) {
    console.log(`✓ ${pack.label} already installed`);
    continue;
  }
  console.log(`↓ ${pack.label} (~${pack.approxMB} MB) from huggingface.co/${pack.repo}`);
  let last = 0;
  await downloadPack(modelsDir, pack, (p) => {
    const now = Date.now();
    if (now - last < 500 && p.received !== p.total) return;
    last = now;
    process.stdout.write(`\r  ${p.fileIndex + 1}/${p.fileCount} ${p.file} ${(p.received / 1e6).toFixed(1)}/${(p.total / 1e6).toFixed(1)} MB      `);
  });
  console.log(`\n✓ ${pack.label} installed`);
}
