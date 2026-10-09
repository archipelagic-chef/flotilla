import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from 'vitest';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function makeTempDir(prefix = 'switchyard-'): string {
  const base = fs.realpathSync.native(os.tmpdir());
  return fs.realpathSync.native(fs.mkdtempSync(path.join(base, prefix)));
}

export function initRepo(dir: string = makeTempDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return fs.realpathSync.native(dir);
}

export function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best effort: temp dirs are cleaned by the OS eventually
  }
}

/** Copies the repo to a new absolute path and renames the original away, like a second environment seeing the repo at a different mount path. */
export function simulateOtherEnvironment(repo: string): string {
  const other = makeTempDir('switchyard-other-');
  fs.rmSync(other, { recursive: true, force: true });
  fs.cpSync(repo, other, { recursive: true });
  fs.renameSync(repo, `${repo}-gone`);
  return other;
}

function key(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function expectSamePath(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(key(actual as string)).toBe(key(expected));
}
