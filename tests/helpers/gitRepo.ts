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

export function makeTempDir(prefix = 'flotilla-'): string {
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

/**
 * Commits the given files, then rewrites each with identical content and an mtime 10 minutes in the past:
 * the index's stat data no longer matches (stat-dirty) but the content does, and the entries are not racy.
 */
export function makeStatDirty(root: string, rels: string[]): void {
  for (const rel of rels) writeFile(root, rel, `${rel}\n`);
  git(root, 'add', ...rels);
  git(root, 'commit', '-q', '-m', 'stat-dirty fixture');
  restatInPast(root, rels);
}

/** Rewrites tracked files with identical content and an mtime 10 minutes in the past (stat-dirty, not racy). */
export function restatInPast(root: string, rels: string[]): void {
  const past = new Date(Date.now() - 10 * 60_000);
  for (const rel of rels) {
    const file = path.join(root, rel);
    fs.writeFileSync(file, fs.readFileSync(file));
    fs.utimesSync(file, past, past);
  }
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best effort: temp dirs are cleaned by the OS eventually
  }
}

/**
 * Creates a repo at <realParent>/repo and a symlink <linkHolder>/c -> realParent, like a workspace opened through a
 * symlinked folder. `linkedRepo` is the repo seen through the symlink. Needs symlink privileges (skip on win32).
 */
export function symlinkedRepo(): { repo: string; linkedRepo: string; dirs: string[] } {
  const realParent = makeTempDir();
  const repo = initRepo(path.join(realParent, 'repo'));
  const linkHolder = makeTempDir('flotilla-link-');
  const link = path.join(linkHolder, 'c');
  fs.symlinkSync(realParent, link, 'dir');
  return { repo, linkedRepo: path.join(link, 'repo'), dirs: [realParent, linkHolder] };
}

/** Copies the repo to a new absolute path and renames the original away, like a second environment seeing the repo at a different mount path. */
export function simulateOtherEnvironment(repo: string): string {
  const other = makeTempDir('flotilla-other-');
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
