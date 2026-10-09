import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/tests/vscode/**/*.test.js',
  workspaceFolder: './.vscode-test/fixture-repo',
  mocha: { timeout: 60_000 },
});
