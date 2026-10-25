import { GitError, runGit } from './gitCli';

/** A conflicted file of a merge: its regions, each with its lines and whether both sides only added lines there. */
export interface ConflictedFile {
  file: string;
  regions: { lines: number; additions: boolean }[];
}

/**
 * The regions of a file's text a merge left conflicted (diff3 markers): the lines of both sides, and whether the base
 * had none there (both sides only added lines at the same spot, BL-155).
 */
export function parseConflictRegions(text: string): ConflictedFile['regions'] {
  const out: ConflictedFile['regions'] = [];
  let part: 'ours' | 'base' | 'theirs' | undefined;
  let lines = 0;
  let base = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') {
      part = 'ours';
      lines = 0;
      base = 0;
    } else if (part === 'ours' && (line.startsWith('||||||| ') || line === '|||||||')) part = 'base';
    else if ((part === 'ours' || part === 'base') && line === '=======') part = 'theirs';
    else if (part === 'theirs' && (line.startsWith('>>>>>>> ') || line === '>>>>>>>')) {
      out.push({ lines, additions: base === 0 });
      part = undefined;
    } else if (part === 'base') base++;
    else if (part) lines++;
  }
  return out;
}

/**
 * What merging theirs into ours conflicts in, file by file with its regions, without touching a worktree (git 2.38+:
 * merge-tree --write-tree). Files that conflict without markers (deleted on one side, binary) have no regions.
 */
export async function conflictRegions(cwd: string, ours: string, theirs: string): Promise<ConflictedFile[]> {
  let out: string;
  try {
    await runGit(['-c', 'merge.conflictStyle=diff3', 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], {
      cwd,
      timeoutMs: 120_000,
    });
    return [];
  } catch (e) {
    // Exit 1: conflicts. The output is the tree's id, then the conflicted files (NUL-separated with -z).
    if (!(e instanceof GitError) || e.exitCode !== 1 || !e.stdout) throw e;
    out = e.stdout;
  }
  const [tree, ...names] = out.split('\0').filter(Boolean);
  const files: ConflictedFile[] = [];
  for (const file of [...new Set(names)]) {
    const text = await runGit(['cat-file', 'blob', `${tree.trim()}:${file}`], { cwd }).catch(() => '');
    files.push({ file, regions: parseConflictRegions(text) });
  }
  return files;
}
