// Checks what this app needs and says how to fix anything missing.
// Usage: npm run doctor   (exit code 1 if something required is missing)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const results = [];
const check = (level, name, ok, detail, fix) => results.push({ level, name, ok, detail, fix });

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(), code: e.status };
  }
}

// Runtime
const [major] = process.versions.node.split('.').map(Number);
check('required', 'Node.js', major >= 20, `v${process.versions.node}`, 'Install Node.js 20 or newer from https://nodejs.org');
check('required', 'Dependencies installed', fs.existsSync('node_modules/electron'), fs.existsSync('node_modules/electron') ? 'node_modules present' : 'node_modules missing', 'Run: npm ci');
check('required', 'App built', fs.existsSync('dist/main/main.mjs'), fs.existsSync('dist/main/main.mjs') ? 'dist/ present' : 'not built yet', 'Run: npm run build');

// Agents
const claude = run('claude', ['--version']);
let claudeAuth = 'unknown';
if (claude.ok) {
  const s = run('claude', ['auth', 'status']);
  try {
    claudeAuth = JSON.parse(s.out).loggedIn ? 'signed in' : 'not signed in';
  } catch {
    claudeAuth = 'could not check';
  }
}
check('optional', 'Claude Code', claude.ok && claudeAuth === 'signed in', claude.ok ? `${claude.out} (${claudeAuth})` : 'not installed', claude.ok ? 'Run "claude" once in a terminal and sign in.' : 'npm install -g @anthropic-ai/claude-code, then run "claude" to sign in.');
const codex = run('codex', ['--version']);
check('optional', 'Codex CLI', codex.ok, codex.ok ? `${codex.out} (adapter not finished in this version)` : 'not installed (adapter not finished in this version)', 'npm install -g @openai/codex, then "codex login".');

// Speech models
const appData = process.env.APPDATA ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
const models = process.env.VCC_MODELS_DIR ?? path.join(appData, 'voice-coding-companion', 'models');
const has = (repo, file) => fs.existsSync(path.join(models, ...repo.split('/'), file));
const stt = ['onnx-community/moonshine-base-ONNX', 'onnx-community/whisper-base.en', 'onnx-community/whisper-tiny.en'].filter((r) => has(r, 'onnx/encoder_model_quantized.onnx'));
check('recommended', 'On-device speech recognition', stt.length > 0, stt.length ? stt.join(', ') : `none in ${models}`, 'Run: npm run models   (or use the setup wizard; cloud recognition is the alternative)');
check('optional', 'Natural voice (Kokoro)', has('onnx-community/Kokoro-82M-v1.0-ONNX', 'onnx/model_quantized.onnx'), has('onnx-community/Kokoro-82M-v1.0-ONNX', 'onnx/model_quantized.onnx') ? 'installed' : 'not downloaded; the system voice is used', 'Run: npm run models -- kokoro   (slow on older CPUs)');

// Machine
const cpus = os.cpus();
check('info', 'Machine', true, `${os.platform()} ${os.arch()}, ${cpus.length} threads (${cpus[0]?.model ?? '?'}), ${Math.round(os.totalmem() / 1e9)} GB RAM`);
if (process.platform === 'linux') check('optional', 'Speech synthesis (Linux)', run('which', ['speech-dispatcher']).ok, 'needed for system voices', 'Install speech-dispatcher (e.g. sudo apt install speech-dispatcher).');

const icon = (r) => (r.ok ? '✓' : r.level === 'required' ? '✗' : r.level === 'info' ? '·' : '!');
for (const r of results) {
  console.log(`${icon(r)} ${r.name}: ${r.detail}`);
  if (!r.ok && r.fix) console.log(`    → ${r.fix}`);
}
const missing = results.filter((r) => !r.ok && r.level === 'required');
console.log(missing.length ? `\n${missing.length} required item(s) missing.` : '\nReady. Start the app with: npm start');
process.exit(missing.length ? 1 : 0);
