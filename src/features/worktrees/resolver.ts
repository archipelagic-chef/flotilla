import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isInside, pathKey, samePath } from '../../core/paths';
import { worktreesRoot } from './layout';
import { isLocked, isPortable, readBackPointer, readGitFile, resolveGitdir } from './portability';

export interface RepoRoots {
  mainRoot: string;
  commonDir: string;
}

export interface ResolvedWorktree {
  /** Name of the admin dir under .git/worktrees; undefined for the main worktree. */
  id: string | undefined;
  isMain: boolean;
  /** .git/worktrees/<id> (commonDir for main). Also this worktree's git dir. */
  adminDir: string;
  /** Location in THIS environment; undefined when unreachable. */
  path: string | undefined;
  /** Location as recorded by git (may be another environment's path). */
  recordedPath: string;
  branch: string | undefined;
  head: string | undefined;
  locked: boolean;
  portable: boolean;
  insideRepo: boolean;
}

export async function readHead(adminDir: string): Promise<{ branch?: string; head?: string }> {
  try {
    const text = (await fs.readFile(path.join(adminDir, 'HEAD'), 'utf8')).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    return m ? { branch: m[1] } : { head: text };
  } catch {
    return {};
  }
}

async function pointsBackTo(worktreeDir: string, adminDir: string): Promise<boolean> {
  const value = await readGitFile(worktreeDir);
  return value !== undefined && samePath(resolveGitdir(worktreeDir, value), adminDir);
}

async function scanWorktreesDir(mainRoot: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const root = worktreesRoot(mainRoot);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const value = await readGitFile(dir);
    if (value) found.set(pathKey(resolveGitdir(dir, value)), dir);
  }
  return found;
}

export async function resolveWorktrees(roots: RepoRoots): Promise<ResolvedWorktree[]> {
  const mainHead = await readHead(roots.commonDir);
  const result: ResolvedWorktree[] = [
    {
      id: undefined,
      isMain: true,
      adminDir: roots.commonDir,
      path: roots.mainRoot,
      recordedPath: roots.mainRoot,
      branch: mainHead.branch,
      head: mainHead.head,
      locked: false,
      portable: true,
      insideRepo: false,
    },
  ];

  let ids: string[] = [];
  try {
    const entries = await fs.readdir(path.join(roots.commonDir, 'worktrees'), { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return result;
  }
  const scanned = await scanWorktreesDir(roots.mainRoot);

  for (const id of ids) {
    const adminDir = path.join(roots.commonDir, 'worktrees', id);
    const back = await readBackPointer(adminDir);
    const recordedPath = back ? path.dirname(back) : '';
    let location: string | undefined;
    if (back && (await pointsBackTo(recordedPath, adminDir))) location = path.resolve(recordedPath);
    location ??= scanned.get(pathKey(adminDir));
    const head = await readHead(adminDir);
    result.push({
      id,
      isMain: false,
      adminDir,
      path: location,
      recordedPath,
      branch: head.branch,
      head: head.head,
      locked: await isLocked(adminDir),
      portable: location ? await isPortable(location, adminDir) : false,
      insideRepo: location ? isInside(roots.mainRoot, location) : false,
    });
  }
  return result;
}
