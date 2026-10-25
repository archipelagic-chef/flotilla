import { constants, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { rawFs } from '../../core/rawFs';
import { WORKTREES_DIR } from './layout';

// Not Electron's fs: linked folders can hold .asar files (see rawFs).
const fs = rawFs().promises;

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
  /** Files copied instead, as installs or tools write them in place (writtenInPlace). */
  copied: number;
  /** Why the folder wasn't linked; the setup command makes it as it would without linking. */
  skipped?: string;
}

/**
 * Gives a new worktree the main worktree's `folders` (e.g. node_modules) as hard links: the same files, no extra space,
 * and an install in the worktree replaces only what its branch changes (npm and pnpm write new files, they don't edit
 * them in place). What installs or tools do write in place is copied instead (writtenInPlace). Symbolic links inside are
 * made again, not followed. Where hard links can't be made (another drive, a filesystem without them) the folder's
 * partial copy is removed and it's skipped; nothing fails.
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
      results.push({ folder, files: 0, copied: 0, skipped: 'it is outside the worktree' });
      continue;
    }
    const source = await fs.lstat(from).catch(() => undefined);
    if (!source?.isDirectory()) {
      results.push({ folder, files: 0, copied: 0, skipped: 'the main worktree has no such folder' });
      continue;
    }
    if (await fs.lstat(to).catch(() => undefined)) {
      results.push({ folder, files: 0, copied: 0, skipped: 'the new worktree has it already' });
      continue;
    }
    try {
      results.push({ folder, ...(await linkTree(from, to, link)) });
    } catch (error) {
      await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      results.push({ folder, files: 0, copied: 0, skipped: code === 'EXDEV' ? 'it is on another drive' : `hard links failed (${code ?? String(error)})` });
    }
  }
  return results;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Recreates `from`'s directories at `to`, hard-links its files and copies those written in place; says how many. */
async function linkTree(from: string, to: string, link: (from: string, to: string) => Promise<void>): Promise<{ files: number; copied: number }> {
  const files: Array<{ rel: string; copy: boolean }> = [];
  const symlinks: string[] = [];
  const pending = [{ rel: '', copy: false }];
  while (pending.length) {
    const { rel, copy } = pending.pop()!;
    await fs.mkdir(path.join(to, rel), { recursive: true });
    const entries: Dirent[] = await fs.readdir(path.join(from, rel), { withFileTypes: true });
    for (const e of entries) {
      const child = { rel: path.join(rel, e.name), copy };
      if (e.isSymbolicLink()) symlinks.push(child.rel);
      else if (e.isDirectory() || e.isFile()) {
        child.copy ||= await writtenInPlace(path.join(from, rel), e.name, e.isDirectory());
        (e.isDirectory() ? pending : files).push(child);
      }
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const { rel, copy } = files[next++];
      if (copy) await fs.copyFile(path.join(from, rel), path.join(to, rel));
      else await link(path.join(from, rel), path.join(to, rel));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, files.length) }, worker));
  for (const rel of symlinks) await copySymlink(path.join(from, rel), path.join(to, rel), from, to);
  const copied = files.filter((f) => f.copy).length;
  return { files: files.length - copied, copied };
}

/** npm's scripts run at install; a package with a binding.gyp and none of them gets `node-gyp rebuild`. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/**
 * Whether the entry `name` of `dir` (in a linked folder) is written in place, so it must be a copy, not a hard link:
 * a write into a link writes the main worktree's file (and every other worktree's). In a node_modules folder, those are
 * the tools' own entries, which start with a dot (npm rewrites .package-lock.json at each install, vitest its results
 * in .vite, others .cache), and packages with install scripts, which write into the package: `@vscode/vsce-sign`
 * copies its binary over `bin/vsce-sign`, `esbuild` writes `bin/esbuild` when it downloads it, and node-gyp builds
 * into `build/`, for the platform they run on. npm itself doesn't write in place: it unlinks a file before writing it.
 */
async function writtenInPlace(dir: string, name: string, isDirectory: boolean): Promise<boolean> {
  const parent = path.basename(dir);
  const scoped = parent.startsWith('@') && path.basename(path.dirname(dir)) === 'node_modules';
  if (parent !== 'node_modules' && !scoped) return false;
  if (parent === 'node_modules' && name.startsWith('.')) return true;
  if (!isDirectory || (parent === 'node_modules' && name.startsWith('@'))) return false;
  const pkg = path.join(dir, name);
  const manifest = await fs
    .readFile(path.join(pkg, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { scripts?: Record<string, unknown> } | null)
    .catch(() => undefined);
  if (INSTALL_SCRIPTS.some((s) => typeof manifest?.scripts?.[s] === 'string')) return true;
  return !!manifest && !!(await fs.lstat(path.join(pkg, 'binding.gyp')).catch(() => undefined));
}

/** Makes `dest` a link like `src`; a link into the folder points into the new copy, others where they pointed. */
async function copySymlink(src: string, dest: string, fromRoot: string, toRoot: string): Promise<void> {
  const target = await fs.readlink(src);
  // Windows reads junctions back with the \\?\ prefix.
  const resolved = path.resolve(path.dirname(src), target.replace(/^\\\\\?\\/, ''));
  const isDir = (await fs.stat(src).catch(() => undefined))?.isDirectory() ?? false;
  const mapped = isInside(fromRoot, resolved) ? path.join(toRoot, path.relative(fromRoot, resolved)) : resolved;
  if (process.platform === 'win32') {
    // Junctions need an absolute target, and file symlinks need a right most users don't have: copy those instead.
    if (isDir) await fs.symlink(mapped, dest, 'junction');
    else await fs.copyFile(src, dest).catch(() => undefined);
    return;
  }
  // Relative targets already resolve the same way inside the copy; absolute ones must be moved into it.
  await fs.symlink(path.isAbsolute(target) ? mapped : target, dest);
}

/** Files larger than this are left as they are by shareLinkedFolder (comparing them costs more than they're worth). */
const SHARE_MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface ShareResult {
  folder: string;
  /** Files that now are hard links to the main worktree's. */
  files: number;
  /** The space that frees. */
  bytes: number;
  /** Identical files that couldn't be replaced (in use). */
  skipped: number;
  /** Links to the main worktree's files that are written in place, made copies again. */
  unshared: number;
}

/**
 * Makes a worktree's copy of a linked folder share the main worktree's files: each file that is identical (same path,
 * same content) and not linked yet becomes a hard link to the main worktree's, replaced atomically (a link made next to
 * it, renamed over it). Files that differ, a branch's own packages, stay as they are; so do files in use (Windows
 * refuses the rename), which are counted as skipped. Links aren't followed. Files written in place (writtenInPlace) are
 * never shared, and where they are (worktrees linked before), they become copies again, the same way.
 */
export async function shareLinkedFolder(mainRoot: string, worktreeDir: string, folder: string): Promise<ShareResult> {
  const result: ShareResult = { folder, files: 0, bytes: 0, skipped: 0, unshared: 0 };
  const from = path.resolve(mainRoot, folder);
  const to = path.resolve(worktreeDir, folder);
  if (!isInside(mainRoot, from) || !isInside(worktreeDir, to)) return result;
  const files: Array<{ rel: string; copy: boolean }> = [];
  const pending = [{ rel: '', copy: false }];
  while (pending.length) {
    const { rel, copy } = pending.pop()!;
    const entries: Dirent[] = await fs.readdir(path.join(to, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() && !e.isFile()) continue;
      const child = { rel: path.join(rel, e.name), copy: copy || (await writtenInPlace(path.join(to, rel), e.name, e.isDirectory())) };
      (e.isDirectory() ? pending : files).push(child);
    }
  }
  let next = 0;
  // Another drive: no file can be linked, so none is compared.
  let otherDrive = false;
  const worker = async () => {
    while (next < files.length && !otherDrive) {
      const { rel, copy } = files[next++];
      const mine = path.join(to, rel);
      const theirs = path.join(from, rel);
      const [a, b] = await Promise.all([fs.lstat(mine).catch(() => undefined), fs.lstat(theirs).catch(() => undefined)]);
      if (copy) {
        if (a && b && a.nlink > 1 && a.dev === b.dev && a.ino === b.ino && (await replaceWithCopy(mine))) result.unshared++;
        continue;
      }
      if (!a || !b || !b.isFile() || a.nlink > 1 || a.size !== b.size || a.size > SHARE_MAX_FILE_BYTES) continue;
      if (a.dev === b.dev && a.ino === b.ino) continue;
      const [x, y] = await Promise.all([fs.readFile(mine), fs.readFile(theirs)]).catch(() => [undefined, undefined]);
      if (!x || !y || !x.equals(y)) continue;
      const tmp = `${mine}.${process.pid}.flotilla-link`;
      try {
        await fs.link(theirs, tmp);
        await fs.rename(tmp, mine);
        result.files++;
        result.bytes += a.size;
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') otherDrive = true;
        else result.skipped++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, files.length) }, worker));
  return result;
}

/** Makes `file`, a hard link, a file of its own with the same content, replaced atomically; false where it can't (in use). */
async function replaceWithCopy(file: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.flotilla-copy`;
  try {
    await fs.copyFile(file, tmp);
    await fs.rename(tmp, file);
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}
