import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

// VS Code is downloaded once, into the main worktree's .vscode-test/, and every worktree's test run uses that copy:
// left to itself, each worktree would download its own (~1 GB) into its own .vscode-test/.
function mainRoot() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return path.dirname(commonDir);
  } catch {
    return process.cwd();
  }
}

/** Deletes the other versions of this platform's download (VS Code isn't pinned: each release is a new folder). */
function pruneOlder(cachePath, executable) {
  const current = path.relative(cachePath, executable).split(path.sep)[0];
  const platform = current.replace(/-\d+\.\d+\.\d+$/, '');
  for (const name of fs.readdirSync(cachePath)) {
    if (name === current || !name.startsWith(`${platform}-`) || !/-\d+\.\d+\.\d+$/.test(name)) continue;
    console.log(`Deleting an older VS Code download: ${name}`);
    fs.rmSync(path.join(cachePath, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

const cachePath = path.join(mainRoot(), '.vscode-test');
const executable = await downloadAndUnzipVSCode({ cachePath });
pruneOlder(cachePath, executable);

export default defineConfig({
  files: 'out/tests/vscode/**/*.test.js',
  workspaceFolder: './.vscode-test/fixture-repo',
  mocha: { timeout: 60_000 },
  useInstallation: { fromPath: executable },
});
