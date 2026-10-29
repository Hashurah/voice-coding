// Bundles main, preload, renderer and workers with esbuild, and copies the
// runtime assets (VAD model, AudioWorklet, ONNX Runtime WASM) next to the UI.
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
const dev = process.argv.includes('--dev');
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: dev ? 'inline' : 'linked', logLevel: 'warning', target: 'es2023', legalComments: 'none' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: `${out}/main/main.mjs`, platform: 'node', format: 'esm', packages: 'external' }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: `${out}/preload/preload.cjs`, platform: 'node', format: 'cjs', external: ['electron'] }),
  build({
    ...common,
    entryPoints: ['src/renderer/app.ts'],
    outdir: `${out}/renderer`,
    platform: 'browser',
    format: 'esm',
    splitting: true,
    minify: !dev,
  }),
  build({ ...common, entryPoints: ['src/speech/speechHost.ts'], outfile: `${out}/speech/speechHost.mjs`, platform: 'node', format: 'esm', packages: 'external' }),
]);

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};
copy('src/renderer/index.html', `${out}/renderer/index.html`);
copy('src/renderer/styles.css', `${out}/renderer/styles.css`);

const vadDist = 'node_modules/@ricky0123/vad-web/dist';
copy(`${vadDist}/silero_vad_v5.onnx`, `${out}/renderer/vendor/vad/silero_vad_v5.onnx`);
copy(`${vadDist}/vad.worklet.bundle.min.js`, `${out}/renderer/vendor/vad/vad.worklet.bundle.min.js`);

// The VAD runs in the page on ONNX Runtime WASM matching vad-web's own version.
const ortFor = (fromPkg) => {
  const nested = `node_modules/${fromPkg}/node_modules/onnxruntime-web/dist`;
  return fs.existsSync(nested) ? nested : 'node_modules/onnxruntime-web/dist';
};
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'])
  copy(`${ortFor('@ricky0123/vad-web')}/${f}`, `${out}/renderer/vendor/ort-vad/${f}`);

const size = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).reduce((n, d) => (d.isFile() ? n + fs.statSync(path.join(d.parentPath, d.name)).size : n), 0);
console.log(`Built ${out}/ (${(size(out) / 1e6).toFixed(1)} MB)`);
