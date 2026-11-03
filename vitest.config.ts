import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The webview's components (.tsx) are Preact's, as tsconfig.webview.json builds them.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globalSetup: ['tests/helpers/tempRoot.ts', 'tests/helpers/seedKit.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
