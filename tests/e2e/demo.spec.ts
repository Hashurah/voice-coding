// End-to-end checks in the real Electron app, using the demo agent and the keyboard.
import { expect, test } from '@playwright/test';
import { appLog, launch, send, spoken, type Launched } from './helpers';

let l: Launched;
test.afterEach(async () => l?.close());

test('runs a task with an approval, a mid-task follow-up and an evidence-based report', async () => {
  l = await launch();
  const { page } = l;
  await expect(page.locator('#conn')).toContainText('Demo agent: ready');

  await send(page, 'Analyse my authentication system, identify the bug, fix it and run the tests');
  await expect(page.locator('.msg.user').last()).toContainText('Analyse my authentication system');
  await expect(page.locator('#agentState')).toContainText('working');

  // A follow-up while the task runs is added, not a restart.
  await send(page, 'Also check whether the fix affects password resets.');
  await expect(page.locator('.task')).toHaveCount(1);

  // The agent waits for approval; the A key approves.
  await expect(page.locator('.approval:not(.done)')).toBeVisible();
  await expect(page.locator('#agentState')).toContainText('approval');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('a');
  await expect(page.locator('.approval.done')).toContainText('Approved');

  const report = page.locator('.report');
  await expect(report).toBeVisible();
  await expect(report).toContainText('Completed');
  await expect(report).toContainText('session.ts');
  await expect(report).toContainText('npm test');
  await expect(page.locator('.task .t-fu')).toContainText('accepted');
  await expect(page.locator('.tool', { hasText: 'Following up' })).toHaveCount(1);
  // The failed first test run stays visible in the transcript.
  await expect(page.locator('.tool', { hasText: 'exit 1' })).toHaveCount(1);

  const said = await spoken(page);
  expect(said.some((s) => /passed that on|sent that/.test(s))).toBe(true);
  expect(said.some((s) => /approval/i.test(s))).toBe(true);
  expect(said.at(-1)).toMatch(/finished/);
  expect(said.join(' ')).not.toMatch(/```|at \S+:\d+:\d+/);
});

test('cancels only on an explicit stop and reports the real result', async () => {
  l = await launch();
  const { page } = l;
  await send(page, 'Fix the auth bug');
  await expect(page.locator('.approval:not(.done)')).toBeVisible();
  await send(page, 'Rename the user table');
  await expect(page.locator('#question')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#question button', { hasText: 'Separate task' }).click();
  await expect(page.locator('.task')).toHaveCount(2);

  await send(page, 'stop');
  await expect(page.locator('.report.cancelled')).toBeVisible();
  await expect(page.locator('.task .st.cancelled')).toHaveCount(1);
  // The queued separate task then starts.
  await expect(page.locator('.approval:not(.done)')).toBeVisible();
  expect((await spoken(page)).some((s) => /cancelled|stopped/i.test(s))).toBe(true);
});

test('keeps the transcript across an agent switch and a restart', async () => {
  l = await launch();
  await send(l.page, 'Why is the sky blue?');
  await expect(l.page.locator('.msg.agent').last()).toContainText('demo agent');
  await expect(l.page.locator('.task .st.completed')).toHaveCount(1);
  await l.page.selectOption('#agent', 'codex');
  await expect(l.page.locator('.msg.system').last()).toContainText('Switched to Codex');
  await send(l.page, 'Fix the build');
  await expect(l.page.locator('.report.failed')).toContainText("Codex adapter isn't available");
  const userData = l.userData;
  await l.close();

  l = await launch({ env: { VCC_USER_DATA: userData } });
  await expect(l.page.locator('.msg.user')).toHaveCount(2);
  await expect(l.page.locator('.msg.user').first()).toContainText('Why is the sky blue?');
  expect(appLog(userData)).toContain('Shut down cleanly');
});

test('reports a denied microphone and keeps typing available', async () => {
  l = await launch({ env: { VCC_DENY_MIC: '1' } });
  const { page } = l;
  await page.locator('#mic').dispatchEvent('pointerdown');
  await expect(page.locator('.msg.system.error', { hasText: /Microphone access was refused|microphone could not start/i })).toHaveCount(1);
  // With the mic refused, the app shouldn't also nag about speech models.
  await expect(page.locator('.msg.system.error', { hasText: /speech model/i })).toHaveCount(0);
  await expect(page.locator('#voiceState')).toContainText('unavailable');
  await send(page, 'Is the app still usable?');
  await expect(page.locator('.msg.agent').last()).toBeVisible();
});
