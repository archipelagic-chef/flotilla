import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
import { WORKING } from '../../core/diff/refs';

export type CompareMode = 'mergeBase' | 'twoDot' | 'uncommitted';

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
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchyard-index-'));
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
