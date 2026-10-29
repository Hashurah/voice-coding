// First-run setup wizard, as a new user sees it.
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launch, send, type Launched } from './helpers';

let l: Launched;
test.afterEach(async () => l?.close());

test('a new user goes through setup and lands in a working demo', async () => {
  l = await launch({ settings: { firstRunDone: false } });
  const { page } = l;
  const wizard = page.locator('#wizard');
  await expect(wizard).toBeVisible();
  await expect(wizard).toContainText('Speech stays on this computer by default');
  await wizard.locator('[data-next]').click();
  await expect(wizard).toContainText('Checking your computer');
  await expect(wizard).toContainText('Demo agent');
  await wizard.locator('[data-next]').click();
  await expect(wizard).toContainText('On-device speech');
  await expect(wizard.locator('[data-model]')).not.toHaveCount(0);
  await wizard.locator('[data-next]').click();
  await expect(wizard).toContainText('Microphone and voice');
  await wizard.locator('[data-next]').click();
  await expect(wizard).toContainText('Agent and project');
  await wizard.locator('input[name=wagent][value=demo]').check();
  await wizard.locator('[data-next]').click(); // Finish
  await expect(wizard).toBeHidden();

  const saved = JSON.parse(fs.readFileSync(path.join(l.userData, 'settings.json'), 'utf8'));
  expect(saved.firstRunDone).toBe(true);
  expect(saved.agentId).toBe('demo');

  await send(page, 'What can you do?');
  await expect(page.locator('.msg.agent').last()).toContainText('demo agent');
});
