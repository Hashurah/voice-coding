// Voice end to end: a WAV file is fed in as the microphone (Chromium fake
// capture), through the real VAD, Whisper and turn-taking code.
import { expect, test } from '@playwright/test';
import { appLog, launch, modelsAvailable, spoken, type Launched } from './helpers';

test.skip(!modelsAvailable(), 'On-device speech models are not installed (npm run models).');

let l: Launched;
test.afterEach(async () => l?.close());

async function listen(fakeAudio: string, settings: Record<string, unknown> = {}) {
  l = await launch({ fakeAudio, settings: { listenMode: 'continuous', ...settings } });
  return l.page;
}

test('a spoken task is transcribed, shown and started', async () => {
  const page = await listen('task.wav');
  const msg = page.locator('.msg.user');
  await expect(msg).toHaveCount(1, { timeout: 90_000 });
  await expect(msg).toContainText(/authentication system/i);
  await expect(msg).toContainText('voice');
  await expect(page.locator('.task')).toHaveCount(1);
  console.log(appLog(l.userData).split('\n').filter((x) => /STT|Whisper/.test(x)).join('\n'));
});

test('a natural pause mid-sentence does not submit early', async () => {
  const page = await listen('pause-mid-sentence.wav');
  const msg = page.locator('.msg.user');
  await expect(msg).toHaveCount(1, { timeout: 90_000 });
  await page.waitForTimeout(6000);
  await expect(msg).toHaveCount(1);
  await expect(msg).toContainText(/login bug.*run the tests/i);
  console.log(appLog(l.userData).split('\n').filter((x) => /STT/.test(x)).join('\n'));
});

test('a self-correction keeps only the corrected instruction', async () => {
  const page = await listen('self-correction.wav');
  const msg = page.locator('.msg.user');
  await expect(msg).toHaveCount(1, { timeout: 90_000 });
  await expect(msg).toContainText(/sign ?up page/i);
  await expect(msg).not.toContainText(/login/i);
});

test('push-to-talk with silence says nothing was heard', async () => {
  l = await launch({ fakeAudio: 'stop.wav' });
  const { page } = l;
  // Hold for only the leading silence of the file.
  await page.locator('#mic').dispatchEvent('pointerdown');
  await expect(page.locator('#voiceState')).toContainText(/listening|hearing/, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.locator('#mic').dispatchEvent('pointerup');
  await expect(page.locator('#live')).toContainText(/didn't hear anything|couldn't make that out/);
  await expect(page.locator('.msg.user')).toHaveCount(0);
  expect(await spoken(page)).toEqual([]);
});

test('recovers when the speech engine crashes', async () => {
  const page = await listen('task.wav');
  await expect(page.locator('.msg.user')).toHaveCount(1, { timeout: 90_000 });
  // Kill the speech process, then speak again via a fresh launch of capture.
  expect(await page.evaluate(() => (window as unknown as { vccTest: { killSpeech(): Promise<boolean> } }).vccTest.killSpeech())).toBe(true);
  const r = await page.evaluate(() => (window as unknown as { vcc: { transcribe(a: Float32Array): Promise<{ text: string }> } }).vcc.transcribe(new Float32Array(16000)));
  expect(typeof r.text).toBe('string'); // a new speech process was started and answered
  expect(appLog(l.userData)).toMatch(/Speech process exited/);
});
