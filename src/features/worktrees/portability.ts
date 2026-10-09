import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { samePath, toGitPath } from '../../core/paths';

export const LOCK_REASON = 'switchyard: portable';

/** Overwrites a file in place, preserving attributes like the hidden bit on Windows. */
async function overwriteFile(file: string, content: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  try {
    await handle.truncate(0);
    await handle.writeFile(content);
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

export async function makePortable(worktreeDir: string, adminDir: string): Promise<boolean> {
  if ((await readGitFile(worktreeDir)) === undefined) return false;
  const rel = relativeGitdir(worktreeDir, adminDir);
  if (!rel) return false;
  const gitPath = path.join(worktreeDir, '.git');
  await overwriteFile(gitPath, `gitdir: ${rel}\n`);
  if (!(await isLocked(adminDir))) await lock(adminDir);
  return true;
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
