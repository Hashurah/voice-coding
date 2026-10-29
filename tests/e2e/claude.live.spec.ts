// Claude Code through the full Electron app. Uses your Claude account.
// Runs only when VCC_LIVE=1 (npm run test:e2e:live).
import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appLog, launch, send, spoken, type Launched } from './helpers';

test.skip(process.env.VCC_LIVE !== '1', 'Live agent test: set VCC_LIVE=1 to run.');

let l: Launched;
test.afterEach(async () => l?.close());

test('Claude Code answers inside the app, with health, transcript and spoken summary', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e2e-claude-'));
  fs.writeFileSync(path.join(project, 'README.md'), '# Demo\nA tiny project used by an automated test.\n');
  fs.writeFileSync(path.join(project, 'index.js'), 'console.log("hello");\n');
  l = await launch({ settings: { agentId: 'claude', cwd: project }, env: { VCC_CLAUDE_MODEL: process.env.VCC_CLAUDE_MODEL || 'haiku' } });
  const { page } = l;
  await expect(page.locator('#conn')).toContainText('Claude Code: ready', { timeout: 30_000 });
  await send(page, 'Use your Glob or Read tools (not the shell) to see which files are in this project, then name them in one short sentence.');
  await expect(page.locator('.task .st.completed, .task .st.partial')).toHaveCount(1, { timeout: 180_000 });
  const answer = await page.locator('.msg.agent').last().innerText();
  console.log('ANSWER:', answer);
  expect(answer).toMatch(/README|index\.js/i);
  expect((await spoken(page)).length).toBeGreaterThan(0);
  console.log(appLog(l.userData).split('\n').filter((x) => /claude|error/i.test(x)).slice(-10).join('\n'));
});
