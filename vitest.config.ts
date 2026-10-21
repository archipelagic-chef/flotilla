import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globalSetup: ['tests/helpers/seedKit.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
