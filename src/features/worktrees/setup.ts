import { constants, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { WORKTREES_DIR } from './layout';

export async function copySetupFiles(mainRoot: string, worktreeDir: string, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const files = await glob([...patterns], {
    cwd: mainRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['.git/**', `${WORKTREES_DIR}/**`, '**/node_modules/**'],
  });
  const copied: string[] = [];
  for (const rel of [...new Set(files)].sort()) {
    const target = path.join(worktreeDir, rel);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(mainRoot, rel), target, constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return copied;
}

/** Hard links made at once while a folder is linked. */
const LINK_CONCURRENCY = 32;

export interface LinkResult {
  folder: string;
  /** Files hard-linked (0 when skipped). */
  files: number;
  /** Why the folder wasn't linked; the setup command makes it as it would without linking. */
  skipped?: string;
}

/**
 * Gives a new worktree the main worktree's `folders` (e.g. node_modules) as hard links: the same files, no extra space,
 * and an install in the worktree replaces only what its branch changes (npm and pnpm write new files, they don't edit
 * them in place). Symbolic links inside are made again, not followed. Where hard links can't be made (another drive, a
 * filesystem without them) the folder's partial copy is removed and it's skipped; nothing fails.
 */
export async function linkFolders(
  mainRoot: string,
  worktreeDir: string,
  folders: readonly string[],
  link: (from: string, to: string) => Promise<void> = fs.link,
): Promise<LinkResult[]> {
  const results: LinkResult[] = [];
  for (const folder of [...new Set(folders)]) {
    const from = path.resolve(mainRoot, folder);
    const to = path.resolve(worktreeDir, folder);
    if (!isInside(mainRoot, from) || !isInside(worktreeDir, to)) {
      results.push({ folder, files: 0, skipped: 'it is outside the worktree' });
      continue;
    }
    const source = await fs.lstat(from).catch(() => undefined);
    if (!source?.isDirectory()) {
      results.push({ folder, files: 0, skipped: 'the main worktree has no such folder' });
      continue;
    }
    if (await fs.lstat(to).catch(() => undefined)) {
      results.push({ folder, files: 0, skipped: 'the new worktree has it already' });
      continue;
    }
    try {
      results.push({ folder, files: await linkTree(from, to, link) });
    } catch (error) {
      await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      results.push({ folder, files: 0, skipped: code === 'EXDEV' ? 'it is on another drive' : `hard links failed (${code ?? String(error)})` });
    }
  }
  return results;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Recreates `from`'s directories at `to` and hard-links its files; returns how many files. */
async function linkTree(from: string, to: string, link: (from: string, to: string) => Promise<void>): Promise<number> {
  const files: string[] = [];
  const symlinks: string[] = [];
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop()!;
    await fs.mkdir(path.join(to, rel), { recursive: true });
    const entries: Dirent[] = await fs.readdir(path.join(from, rel), { withFileTypes: true });
    for (const e of entries) {
      const child = path.join(rel, e.name);
      if (e.isSymbolicLink()) symlinks.push(child);
      else if (e.isDirectory()) pending.push(child);
      else if (e.isFile()) files.push(child);
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const rel = files[next++];
      await link(path.join(from, rel), path.join(to, rel));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, files.length) }, worker));
  for (const rel of symlinks) await copySymlink(path.join(from, rel), path.join(to, rel), from, to);
  return files.length;
}

/** Makes `dest` a link like `src`; a link into the folder points into the new copy, others where they pointed. */
async function copySymlink(src: string, dest: string, fromRoot: string, toRoot: string): Promise<void> {
  const target = await fs.readlink(src);
  // Windows reads junctions back with the \\?\ prefix.
  const resolved = path.resolve(path.dirname(src), target.replace(/^\\\\\?\\/, ''));
  const isDir = (await fs.stat(src).catch(() => undefined))?.isDirectory() ?? false;
  if (process.platform === 'win32') {
    // Junctions need an absolute target, and file symlinks need a right most users don't have: copy those instead.
    const mapped = isInside(fromRoot, resolved) ? path.join(toRoot, path.relative(fromRoot, resolved)) : resolved;
    if (isDir) await fs.symlink(mapped, dest, 'junction');
    else await fs.copyFile(src, dest).catch(() => undefined);
    return;
  }
  await fs.symlink(target, dest);
}
