import { runGit } from '../../core/git/gitCli';
import { parseNameStatus, type FileChange } from '../../core/git/porcelain';
import { WORKING } from '../../core/diff/refs';

export type CompareMode = 'mergeBase' | 'twoDot' | 'uncommitted';

export interface CompareResult {
  leftRef: string;
  rightRef: string;
  files: FileChange[];
}

async function nameStatus(cwd: string, refs: string[]): Promise<FileChange[]> {
  return parseNameStatus(await runGit(['diff', '--name-status', '-z', '-M', ...refs], { cwd }));
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
  return { leftRef: mergeBase, rightRef: WORKING, files: await nameStatus(cwd, [mergeBase]) };
}
