import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError, getGitVersion, runGit, runGitBytes, versionAtLeast } from './gitCli';

/**
 * Whether merging one commit into another would conflict, without touching a worktree or the repository's index:
 * a merge in memory. Git 2.38+ does it in one go (`git merge-tree --write-tree`); older git merges the trees into a
 * throwaway index and each file changed on both sides with `git merge-file` (renames aren't followed there).
 */

let hasMergeTree: Promise<boolean> | undefined;

/** The files a merge of `theirs` into `ours` conflicts in (none: it merges cleanly). */
export async function mergeConflicts(cwd: string, ours: string, theirs: string): Promise<string[]> {
  hasMergeTree ??= getGitVersion(cwd).then((v) => !!v && versionAtLeast(v, [2, 38, 0]));
  return (await hasMergeTree) ? mergeTreeConflicts(cwd, ours, theirs) : indexConflicts(cwd, ours, theirs);
}

export async function mergeTreeConflicts(cwd: string, ours: string, theirs: string): Promise<string[]> {
  try {
    await runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], { cwd, timeoutMs: 120_000 });
    return [];
  } catch (e) {
    // Exit 1: conflicts. The output is the tree's id, then the conflicted files (NUL-separated with -z).
    if (!(e instanceof GitError) || e.exitCode !== 1 || !e.stdout) throw e;
    return unique(e.stdout.split('\0').slice(1).filter(Boolean));
  }
}

export async function indexConflicts(cwd: string, ours: string, theirs: string): Promise<string[]> {
  let base: string;
  try {
    base = (await runGit(['merge-base', ours, theirs], { cwd })).trim();
  } catch (e) {
    // Unrelated histories: nothing to merge against.
    if (e instanceof GitError && e.exitCode === 1) return [];
    throw e;
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flotilla-merge-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    await runGit(['read-tree', '-i', '-m', '--aggressive', base, ours, theirs], { cwd, env, timeoutMs: 120_000 });
    const entries = new Map<string, Map<number, { mode: string; oid: string }>>();
    for (const line of (await runGit(['ls-files', '-u', '-z'], { cwd, env })).split('\0').filter(Boolean)) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(line);
      if (!m) continue;
      const stages = entries.get(m[4]) ?? new Map();
      stages.set(Number(m[3]), { mode: m[1], oid: m[2] });
      entries.set(m[4], stages);
    }
    const conflicts: string[] = [];
    for (const [file, stages] of entries) {
      const [b, o, t] = [stages.get(1), stages.get(2), stages.get(3)];
      // Changed on one side and deleted on the other, or not a plain file on both: git can't merge it by itself.
      if (!o || !t || o.mode !== t.mode || !isPlainFile(o.mode) || (b && !isPlainFile(b.mode))) {
        conflicts.push(file);
        continue;
      }
      const write = async (name: string, oid: string | undefined) => {
        const f = path.join(dir, name);
        await fs.promises.writeFile(f, oid ? await runGitBytes(['cat-file', 'blob', oid], { cwd }) : '');
        return f;
      };
      const files = [await write('ours', o.oid), await write('base', b?.oid), await write('theirs', t.oid)];
      try {
        await runGit(['merge-file', '-p', '-q', ...files], { cwd });
      } catch (e) {
        // merge-file exits with the number of conflicts (capped at 127); a negative exit is an error.
        if (!(e instanceof GitError) || e.exitCode === null || e.exitCode < 1 || e.exitCode > 127) throw e;
        conflicts.push(file);
      }
    }
    return conflicts;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function isPlainFile(mode: string): boolean {
  return mode === '100644' || mode === '100755';
}

function unique(files: string[]): string[] {
  return [...new Set(files)];
}
