import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
}

const realModels = path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'voice-coding-companion', 'models');

export function modelsAvailable(): boolean {
  return fs.existsSync(path.join(realModels, 'onnx-community', 'whisper-base.en', 'onnx', 'encoder_model_quantized.onnx'));
}

export async function launch(opts: { settings?: Record<string, unknown>; env?: Record<string, string>; fakeAudio?: string } = {}): Promise<Launched> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e2e-'));
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ firstRunDone: true, agentId: 'demo', speak: true, ttsEngine: 'system', reviewWindowMs: 500, ...opts.settings }),
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VCC_TEST: '1',
    VCC_USER_DATA: userData,
    VCC_MODELS_DIR: realModels,
    ...opts.env,
  };
  if (opts.fakeAudio) env.VCC_FAKE_AUDIO = path.resolve('tests/fixtures/audio', opts.fakeAudio);
  // VCC_EXE runs the tests against a packaged build instead of the source checkout.
  const app = process.env.VCC_EXE ? await electron.launch({ executablePath: process.env.VCC_EXE, env }) : await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[renderer] ${m.text()}`);
  });
  await page.waitForSelector('#log .msg, #log .tool');
  return {
    app,
    page,
    userData,
    async close() {
      await app.close().catch(() => undefined);
    },
  };
}

export async function send(page: Page, text: string): Promise<void> {
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
}

export async function spoken(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __vcc: { spoken: string[] } }).__vcc.spoken]);
}

export function appLog(userData: string): string {
  const f = path.join(userData, 'logs', 'app.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
