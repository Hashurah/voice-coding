// A machine without the on-device speech models (as on a fresh install that
// skipped the download): the mic works, and the app says how to get speech.
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launch, send, type Launched } from './helpers';

let l: Launched;
test.afterEach(async () => l?.close());

test('explains how to enable speech when no model is installed, and typing still works', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-no-models-'));
  l = await launch({ fakeAudio: 'stop.wav', env: { VCC_MODELS_DIR: empty } });
  const { page } = l;
  await page.locator('#mic').dispatchEvent('pointerdown');
  await expect(page.locator('.msg.system.error', { hasText: 'No on-device speech model is installed' })).toHaveCount(1);
  await page.locator('#mic').dispatchEvent('pointerup');
  await expect(page.locator('.msg.system.error', { hasText: /Microphone/ })).toHaveCount(0);
  await send(page, 'Is typing still fine?');
  await expect(page.locator('.msg.agent').last()).toBeVisible();
});
