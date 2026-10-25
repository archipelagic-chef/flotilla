import { GitError, runGit } from '../../core/git/gitCli';
import { resolveInside } from '../../core/paths';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { WORKTREES_DIR } from '../../features/worktrees/layout';
import type { DirEntry } from '../../webview/protocol';

export interface ListOptions {
  /** The main worktree hides `.worktrees/`: each worktree has its own section. */
  hideWorktrees: boolean;
  /** Relative posix path → hidden (from `files.exclude`). */
  isExcluded: (relPath: string) => boolean;
}

/** Builds a matcher from a `files.exclude`-style object; entries set to anything but `true` are ignored. */
export function excludeMatcher(patterns: Record<string, unknown>): (relPath: string) => boolean {
  const globs = Object.entries(patterns)
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
  if (!globs.length) return () => false;
  const match = picomatch(globs, { dot: true });
  return (relPath) => match(relPath);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Lists one directory of a worktree, folders first, the way the Explorer sorts. */
export async function listDirectory(root: string, relDir: string, opts: ListOptions): Promise<DirEntry[]> {
  const dir = resolveInside(root, relDir);
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    if (d.name === '.git') continue;
    if (!relDir && opts.hideWorktrees && d.name === WORKTREES_DIR) continue;
    if (opts.isExcluded(rel)) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(path.join(dir, d.name))).isDirectory();
      } catch {
        // dangling link: list it as a file
      }
    }
    entries.push({ name: d.name, dir: isDir });
  }
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));
}

const IGNORE_CHUNK = 200;

/**
 * Marks the entries git ignores. Tracked files are never reported as ignored, as in the Explorer. One `git
 * check-ignore` per listed folder; errors (not a repository, old git) leave everything unmarked.
 */
export async function markIgnored(root: string, relDir: string, entries: DirEntry[]): Promise<DirEntry[]> {
  if (!entries.length) return entries;
  const rel = (e: DirEntry) => `${relDir ? `${relDir}/` : ''}${e.name}${e.dir ? '/' : ''}`;
  const ignored = new Set<string>();
  for (let i = 0; i < entries.length; i += IGNORE_CHUNK) {
    const chunk = entries.slice(i, i + IGNORE_CHUNK).map(rel);
    try {
      // One path per line, unescaped (-z needs --stdin, which runGit doesn't feed).
      const out = await runGit(['-c', 'core.quotePath=false', 'check-ignore', '--', ...chunk], { cwd: root });
      out
        .split('\n')
        .filter(Boolean)
        .forEach((p) => ignored.add(p));
    } catch (error) {
      // Exit code 1: none of them is ignored.
      if (!(error instanceof GitError && error.exitCode === 1)) return entries;
    }
  }
  return entries.map((e) => (ignored.has(rel(e)) ? { ...e, ignored: true } : e));
}
