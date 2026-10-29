import { defineConfig } from 'vitest/config';

// Live agent tests: real CLIs, real tokens. Run explicitly with `npm run test:live`.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
