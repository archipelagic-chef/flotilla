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
  const dir = path.join(root, relDir);
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
