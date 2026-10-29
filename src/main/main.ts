import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { CodexAdapter } from '../adapters/codexAdapter';
import { DemoAdapter } from '../adapters/demoAdapter';
import { TaskManager } from '../core/taskManager';
import { TranscriptStore } from '../core/transcriptStore';
import type { AgentAdapter, AgentId, AppSnapshot, CredentialName, HealthReport, Settings, UiEvent } from '../shared/types';
import * as os from 'node:os';
import { openaiStt, openaiTts } from './cloudSpeech';
import { downloadPack, isInstalled, MODEL_PACKS } from './models';
import { CredentialStore } from './credentialStore';
import { Logger } from './logger';
import { SettingsStore } from './settingsStore';
import { SpeechService } from './speechService';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..', 'renderer');
const isTest = process.env.VCC_TEST === '1';
if (process.env.VCC_USER_DATA) app.setPath('userData', process.env.VCC_USER_DATA);
if (isTest && process.env.VCC_FAKE_AUDIO) {
  // Test-only: feed a WAV file in as the microphone.
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${process.env.VCC_FAKE_AUDIO}%noloop`);
}
if (isTest) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userData = app.getPath('userData');
const log = new Logger(path.join(userData, 'logs'));
const settings = new SettingsStore(userData);
const credentials = new CredentialStore(userData);
const conversationsDir = path.join(userData, 'conversations');
export const modelsDir = process.env.VCC_MODELS_DIR ?? path.join(userData, 'models');

process.on('uncaughtException', (err) => log.write('error', `uncaught: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => log.write('error', `unhandled rejection: ${(err as Error)?.stack ?? err}`));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock() && !isTest) app.quit();
// A second launch brings the existing window forward instead of opening a rival session.
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

let win: BrowserWindow | null = null;
let tm: TaskManager;
let store: TranscriptStore;
const health: Partial<Record<AgentId, HealthReport>> = {};
const speechSvc = new SpeechService(path.join(here, '..', 'speech', 'speechHost.mjs'), modelsDir, log);

/** The configured on-device recogniser, or the first installed one. */
function sttRepo(): string {
  const order = [settings.get().sttModel, 'moonshine-base', 'whisper-base', 'whisper-tiny'];
  for (const id of order) {
    const pack = MODEL_PACKS.find((p) => p.id === id);
    if (pack && isInstalled(modelsDir, pack)) return pack.repo;
  }
  throw new Error('No on-device speech model is installed. Run setup again (Settings → Run setup) or choose OpenAI speech recognition.');
}

const adapters: Partial<Record<AgentId, AgentAdapter>> = {
  demo: new DemoAdapter({ failFirstTest: true }),
  codex: new CodexAdapter(),
};

async function loadClaudeAdapter(): Promise<void> {
  try {
    const { ClaudeAdapter } = await import('../adapters/claudeAdapter');
    // VCC_CLAUDE_MODEL optionally pins a model (e.g. for cheaper test runs); otherwise Claude Code's own default applies.
    adapters.claude = new ClaudeAdapter(log, { model: process.env.VCC_CLAUDE_MODEL || undefined });
  } catch (err) {
    log.write('warn', `Claude adapter unavailable: ${(err as Error).message}`);
  }
}

function emit(e: UiEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('ui-event', e);
}

function openConversation(id: string | null): void {
  store?.close();
  store = new TranscriptStore(conversationsDir, id ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  tm = new TaskManager({ adapters, emit, store, settings: () => settings.get(), log: (l, m) => log.write(l, m) });
  const loaded = store.load();
  if (loaded.corruptLines) log.write('warn', `Skipped ${loaded.corruptLines} damaged transcript line(s) in ${store.file}`);
  tm.restore(loaded.entries, loaded.tasks);
}

function snapshot(): AppSnapshot {
  const s = settings.get();
  return {
    agentId: s.agentId,
    cwd: s.cwd,
    tasks: [...tm.tasks.values()],
    transcript: tm.entries,
    health,
    settings: s,
    pendingQuestion: tm.pendingQuestion,
  };
}

async function checkHealth(): Promise<typeof health> {
  await Promise.all(
    (['demo', 'claude', 'codex'] as AgentId[]).map(async (id) => {
      const a = adapters[id];
      let report: HealthReport;
      try {
        report = a ? await a.check() : { ok: false, installed: false, detail: 'Adapter failed to load. See the log.' };
      } catch (err) {
        report = { ok: false, installed: false, detail: `Check failed: ${(err as Error).message}` };
      }
      health[id] = report;
      emit({ type: 'health', agentId: id, report });
    }),
  );
  return health;
}

function registerIpc(): void {
  ipcMain.handle('snapshot', () => snapshot());
  ipcMain.handle('submit', (_e, text: string, via: 'voice' | 'keyboard') => tm.submit(String(text).slice(0, 20000), via === 'voice' ? 'voice' : 'keyboard'));
  ipcMain.handle('answerQuestion', (_e, id: string, value: string) => tm.answerQuestion(id, value));
  ipcMain.handle('cancelTask', (_e, id: string) => tm.cancel(id));
  ipcMain.handle('setPriority', (_e, id: string, p: number) => tm.setPriority(id, Number(p) || 0));
  ipcMain.handle('approve', (_e, id: string, d: string) => tm.approve(id, d === 'allow' ? 'allow' : 'deny'));
  ipcMain.handle('switchAgent', (_e, id: AgentId) => {
    if (!['demo', 'claude', 'codex'].includes(id) || settings.get().agentId === id) return;
    settings.update({ agentId: id });
    tm.agentSwitched(id);
  });
  ipcMain.handle('checkHealth', () => checkHealth());
  ipcMain.handle('chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose the project folder the agent may work in', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.update({ cwd: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('updateSettings', (_e, patch: Partial<Settings>) => {
    const { cwd: _ignored, ...safe } = patch ?? {};
    return settings.update(safe);
  });
  ipcMain.handle('newConversation', () => {
    if (tm.activeTask) throw new Error('Finish or cancel the running task first.');
    openConversation(null);
    emit({ type: 'snapshot', snapshot: snapshot() });
  });
  ipcMain.handle('setCredential', (_e, name: CredentialName, value: string | null) => {
    if (name !== 'openai') return { ok: false, error: 'Unknown credential.' };
    try {
      credentials.set(name, value ? String(value).trim() : null);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('credentialStatus', () => ({ openai: credentials.has('openai'), secureStorage: credentials.available() }));
  ipcMain.handle('cloudTts', async (_e, text: string, voice: string, speed: number) => {
    const key = credentials.get('openai');
    if (!key) throw new Error('No OpenAI key is stored.');
    return openaiTts(key, String(text).slice(0, 4000), voice, speed);
  });
  ipcMain.handle('cloudStt', async (_e, audio: ArrayBuffer, mime: string) => {
    const key = credentials.get('openai');
    if (!key) throw new Error('No OpenAI key is stored.');
    return openaiStt(key, audio, mime);
  });
  ipcMain.handle('transcribe', (_e, audio: Float32Array) => {
    if (!(audio instanceof Float32Array) || audio.length > 16000 * 120) throw new Error('Invalid audio.');
    return speechSvc.transcribe(sttRepo(), audio);
  });
  ipcMain.handle('preloadSpeech', async () => {
    try {
      await speechSvc.preload(sttRepo());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('synthesize', (_e, text: string, voice: string, speed: number) => {
    const kokoro = MODEL_PACKS.find((p) => p.id === 'kokoro')!;
    if (!isInstalled(modelsDir, { ...kokoro, files: kokoro.files.filter((f) => !f.startsWith('voices/')) })) throw new Error('The natural voice is not downloaded.');
    return speechSvc.synthesize(String(text).slice(0, 2000), String(voice), Math.min(2, Math.max(0.5, Number(speed) || 1)));
  });
  ipcMain.handle('modelStatus', () =>
    MODEL_PACKS.map((p) => ({ id: p.id, label: p.label, approxMB: p.approxMB, purpose: p.purpose, installed: isInstalled(modelsDir, p) })),
  );
  ipcMain.handle('downloadModels', async (_e, ids: string[]) => {
    try {
      for (const pack of MODEL_PACKS.filter((p) => ids.includes(p.id))) {
        log.write('info', `Downloading model ${pack.repo}`);
        await downloadPack(modelsDir, pack, (p) => emit({ type: 'model_progress', id: p.pack, file: p.file, fileIndex: p.fileIndex, fileCount: p.fileCount, received: p.received, total: p.total }));
      }
      return { ok: true };
    } catch (err) {
      log.write('error', `Model download failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('systemInfo', () => ({
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    memGB: Math.round(os.totalmem() / 1e9),
    electron: process.versions.electron,
  }));
  if (isTest) {
    // Test-only fault injection.
    ipcMain.handle('test:killSpeech', () => speechSvc.killForTest());
  }
  ipcMain.on('log', (_e, level: 'info' | 'warn' | 'error', message: string) => log.write(level, `[renderer] ${String(message).slice(0, 4000)}`));
}

/** Serves the UI and downloaded models from app://, never from arbitrary paths. */
function registerProtocol(): void {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'ui') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    // Downloaded models are served from the same origin, under /models/.
    const root = rel.startsWith('models/') ? modelsDir : rendererDir;
    if (root === modelsDir) rel = rel.slice('models/'.length);
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    // Cross-origin isolation lets ONNX Runtime use several threads for speech models.
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    if (file.endsWith('.mjs') || file.endsWith('.js')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: 'Voice Coding Companion',
    backgroundColor: '#0f1115',
    show: !isTest || process.env.VCC_SHOW === '1',
    webPreferences: {
      preload: path.join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://ui/')) e.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.write('error', `Renderer gone: ${details.reason}`);
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });
  void win.loadURL('app://ui/index.html');
}

app.whenReady().then(async () => {
  // Microphone only, only for our own UI. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ours = wc.getURL().startsWith('app://ui/');
    const audioOnly = permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio');
    if (isTest && process.env.VCC_DENY_MIC === '1') return cb(false);
    cb(ours && !!audioOnly);
  });
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, origin) => permission === 'media' && origin.startsWith('app://ui') && !(isTest && process.env.VCC_DENY_MIC === '1'),
  );

  registerProtocol();
  await loadClaudeAdapter();
  openConversation(TranscriptStore.latestId(conversationsDir));
  registerIpc();
  createWindow();
  log.write('info', `Started ${app.getVersion()} (Electron ${process.versions.electron}) data=${userData}`);
  void checkHealth();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.exit(0);
  const timer = setTimeout(done, 5000);
  speechSvc.dispose();
  tm.shutdown()
    .catch((err) => log.write('error', `shutdown: ${err}`))
    .finally(() => {
      clearTimeout(timer);
      log.write('info', 'Shut down cleanly');
      done();
    });
});
app.on('window-all-closed', () => app.quit());
