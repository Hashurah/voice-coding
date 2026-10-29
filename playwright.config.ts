import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  // On GitHub Actions, failures also become annotations that are readable without signing in.
  reporter: process.env.GITHUB_ACTIONS ? [['github'], ['list']] : [['list']],
});
