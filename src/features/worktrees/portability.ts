import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { samePath, toGitPath } from '../../core/paths';

export const LOCK_REASON = 'flotilla: portable';

/**
 * Overwrites a file in place, preserving attributes like the hidden bit on Windows. Writes at position 0 first
 * and truncates after, so a concurrent reader never sees an empty file.
 */
async function overwriteFile(file: string, content: string): Promise<void> {
  const data = Buffer.from(content, 'utf8');
  const handle = await fs.open(file, 'r+');
  try {
    await handle.write(data, 0, data.length, 0);
    await handle.truncate(data.length);
  } finally {
    await handle.close();
  }
}

/** Returns the raw value of the `gitdir:` line in <worktreeDir>/.git, or undefined if it isn't a gitdir file. */
export async function readGitFile(worktreeDir: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(worktreeDir, '.git'), 'utf8');
    return /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  } catch {
    return undefined; // missing, or .git is a directory
  }
}

export function resolveGitdir(worktreeDir: string, value: string): string {
  return path.resolve(worktreeDir, value);
}

export function isRelativeGitdir(value: string): boolean {
  return !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value);
}

export function relativeGitdir(worktreeDir: string, adminDir: string): string | undefined {
  const rel = path.relative(worktreeDir, adminDir);
  if (path.isAbsolute(rel)) return undefined; // e.g. different drive on Windows
  return toGitPath(rel);
}

export async function readLock(adminDir: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(adminDir, 'locked'), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

export async function isLocked(adminDir: string): Promise<boolean> {
  return (await readLock(adminDir)) !== undefined;
}

export async function lock(adminDir: string, reason: string = LOCK_REASON): Promise<void> {
  await fs.writeFile(path.join(adminDir, 'locked'), `${reason}\n`);
}

export async function unlock(adminDir: string): Promise<void> {
  await fs.rm(path.join(adminDir, 'locked'), { force: true });
}

export async function isPortable(worktreeDir: string, adminDir: string): Promise<boolean> {
  const value = await readGitFile(worktreeDir);
  return value !== undefined && isRelativeGitdir(value) && (await isLocked(adminDir));
}

/** True when git, run in the worktree, resolves its git dir to realAdminDir. */
async function gitDirResolvesTo(worktreeDir: string, realAdminDir: string): Promise<boolean> {
  try {
    const out = (await runGit(['rev-parse', '--git-dir'], { cwd: worktreeDir })).trim();
    return samePath(await fs.realpath(path.resolve(worktreeDir, out)), realAdminDir);
  } catch {
    return false;
  }
}

/**
 * Rewrites <worktreeDir>/.git to a relative gitdir and locks the worktree so a prune in another environment
 * keeps it. Locks first (fail safe), then rewrites, then verifies with git; on failure it restores the .git
 * file (and removes a lock it added) and returns false.
 */
export async function makePortable(worktreeDir: string, adminDir: string): Promise<boolean> {
  if ((await readGitFile(worktreeDir)) === undefined) return false;
  // Git resolves `..` physically, so the relative path must be computed between real paths.
  const realAdminDir = await fs.realpath(adminDir);
  const rel = relativeGitdir(await fs.realpath(worktreeDir), realAdminDir);
  if (!rel) return false;
  const addedLock = !(await isLocked(adminDir));
  if (addedLock) await lock(adminDir);
  const gitPath = path.join(worktreeDir, '.git');
  const original = await fs.readFile(gitPath, 'utf8');
  await overwriteFile(gitPath, `gitdir: ${rel}\n`);
  if (await gitDirResolvesTo(worktreeDir, realAdminDir)) return true;
  await overwriteFile(gitPath, original);
  if (addedLock) await unlock(adminDir);
  return false;
}

export async function readBackPointer(adminDir: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(adminDir, 'gitdir'), 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Points .git/worktrees/<id>/gitdir at the worktree as seen from this environment (what `git worktree repair` does in 2.29+). */
export async function retargetBackPointer(worktreeDir: string, adminDir: string): Promise<boolean> {
  const target = path.join(worktreeDir, '.git');
  const current = await readBackPointer(adminDir);
  if (current && samePath(current, target)) return false;
  await fs.writeFile(path.join(adminDir, 'gitdir'), `${toGitPath(target)}\n`);
  return true;
}
