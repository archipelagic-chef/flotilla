import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
import { WORKING } from '../../core/diff/refs';

import type { CompareMode } from '../../webview/protocol';

export type { CompareMode };

export interface CompareResult {
  leftRef: string;
  rightRef: string;
  files: FileChange[];
}

async function nameStatus(cwd: string, refs: string[], env?: Record<string, string>): Promise<FileChange[]> {
  return parseNameStatus(await runGit(['diff', '--name-status', '-z', '-M', ...refs], { cwd, env }));
}

/**
 * Porcelain `git diff <commit>` against the working tree refreshes and rewrites the index when tracked files
 * are stat-dirty (normal when host and container share a worktree). Run it against a throwaway copy instead.
 */
async function nameStatusWithWorkingTree(cwd: string, ref: string): Promise<FileChange[]> {
  const index = path.resolve(cwd, (await runGit(['rev-parse', '--git-path', 'index'], { cwd })).trim());
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flotilla-index-'));
  try {
    const tempIndex = path.join(tempDir, 'index');
    try {
      await fs.promises.copyFile(index, tempIndex);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // no index yet: git treats a missing GIT_INDEX_FILE as an empty index
    }
    return await nameStatus(cwd, [ref], { GIT_INDEX_FILE: tempIndex });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export async function compareWithBase(worktreeDir: string, base: string, mode: CompareMode): Promise<CompareResult> {
  const cwd = worktreeDir;
  if (mode === 'twoDot') {
    return { leftRef: base, rightRef: 'HEAD', files: await nameStatus(cwd, [base, 'HEAD']) };
  }
  const mergeBase = (await runGit(['merge-base', base, 'HEAD'], { cwd })).trim();
  if (mode === 'mergeBase') {
    return { leftRef: mergeBase, rightRef: 'HEAD', files: await nameStatus(cwd, [mergeBase, 'HEAD']) };
  }
  return { leftRef: mergeBase, rightRef: WORKING, files: await nameStatusWithWorkingTree(cwd, mergeBase) };
}

/** Accepts what a user may type as a base (a branch, tag or commit), never an option. */
export function isRefLike(ref: string): boolean {
  return ref.length > 0 && ref.length <= 250 && !ref.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(ref);
}

/** Branches (local, then remote) and tags, to compare with. */
export async function listRefs(cwd: string): Promise<string[]> {
  const out = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd });
  const refs = out.split(/\r?\n/).filter((r) => r && !r.endsWith('/HEAD'));
  const strip = (prefix: string) => refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
  return [...strip('refs/heads/'), ...strip('refs/remotes/'), ...strip('refs/tags/')];
}

/** Compares after checking that base names a commit, with a readable error when it doesn't. */
export async function compareWithRef(worktreeDir: string, base: string, mode: CompareMode): Promise<CompareResult> {
  if (!isRefLike(base)) throw new Error(`'${base}' is not a branch, tag or commit.`);
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: worktreeDir });
  } catch {
    throw new Error(`There is no branch, tag or commit '${base}'.`);
  }
  return compareWithBase(worktreeDir, base, mode);
}
