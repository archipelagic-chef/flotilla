import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { parseStatusV2 } from '../../core/git/porcelain';
import { samePath } from '../../core/paths';
import { rawFs } from '../../core/rawFs';
import { removeTopLevelLinks } from '../storage/finished';
import {
  ensureExcluded,
  existingNames,
  sanitizeName,
  uniqueName,
  worktreesRoot,
} from './layout';
import {
  lock,
  makePortable,
  readGitFile,
  readLock,
  resolveGitdir,
  retargetBackPointer,
  unlock,
} from './portability';
import {
  type RepoRoots,
  type ResolvedWorktree,
  resolveWorktrees,
} from './resolver';

export type CreateRequest =
  { kind: 'new'; branch: string; startPoint?: string } | { kind: 'existing'; branch: string } | { kind: 'remote'; remoteRef: string; localBranch?: string };

export interface BranchList {
  local: string[];
  remote: string[];
}

export interface RemovalRisks {
  /** Uncommitted + untracked entries that would be deleted. */
  changedFiles: number;
  /** Commits only reachable from this worktree's branch. */
  unmergedCommits: number;
  /**
   * A removal stopped halfway: tracked files were only deleted, none changed or added, and what's untracked the branch's
   * own .gitignore ignores (node_modules/, .playground/). Finishing it loses nothing.
   */
  halfRemoved: boolean;
}

const ADD_TIMEOUT_MS = 120_000;

/** A folder in .worktrees/ without a .git counts as left over only once it hasn't changed for this long. */
const LEFTOVER_MIN_AGE_MS = 10 * 60_000;

/** Whether rel (as git status names it) is a symbolic link or junction directly in dir. */
async function isTopLevelLink(dir: string, rel: string): Promise<boolean> {
  const name = rel.replace(/\/$/, '');
  if (name.includes('/')) return false;
  return (await fs.lstat(path.join(dir, name)).catch(() => undefined))?.isSymbolicLink() ?? false;
}

/**
 * Runs fn with git config that adds the ignore rules of the worktree's HEAD when its .gitignore is gone (a removal that
 * stopped halfway deleted it): node_modules is then still ignored, not untracked work. Nested .gitignore files aren't.
 */
async function withBranchIgnores<T>(dir: string, fn: (config: string[]) => Promise<T>): Promise<T> {
  if (await fs.lstat(path.join(dir, '.gitignore')).catch(() => undefined)) return fn([]);
  const committed = await runGit(['show', 'HEAD:.gitignore'], { cwd: dir }).catch(() => '');
  if (!committed) return fn([]);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-ignore-'));
  try {
    const file = path.join(tmp, 'gitignore');
    await fs.writeFile(file, committed);
    return await fn(['-c', `core.excludesFile=${file}`]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** How many of paths (as git status names them, folders with a trailing /) the branch's ignore rules ignore. */
async function countIgnoredByBranch(dir: string, paths: readonly string[]): Promise<number> {
  if (!paths.length) return 0;
  const out = await withBranchIgnores(dir, (config) =>
    // Exit 1 when none is ignored.
    runGit([...config, 'check-ignore', '-z', '--stdin'], { cwd: dir, input: paths.map((p) => `${p}\0`).join('') }).catch(() => ''),
  );
  return out.split('\0').filter(Boolean).length;
}

/**
 * Deletes the ignored folders in dir (node_modules: tens of thousands of files) as folders, with no time limit, links in
 * them as links. git deletes file by file under its time limit: stopping halfway there left worktrees without their
 * .gitignore, whose node_modules then counted as untracked work.
 */
async function deleteIgnoredFolders(dir: string): Promise<void> {
  const out = await withBranchIgnores(dir, (config) =>
    runGit([...config, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: dir }),
  ).catch(() => '');
  for (const rel of out.split('\0').filter((p) => p.endsWith('/'))) {
    // Not Electron's fs: it would open a VS Code download's .asar as a folder and keep it open (see rawFs).
    await rawFs().promises.rm(path.join(dir, rel), { recursive: true, force: true, maxRetries: 3 });
  }
}

export interface WorktreeServiceOptions {
  autoAdopt: boolean;
  /** Called when auto-adoption of a worktree fails; that worktree is listed as not portable. */
  onAdoptError?: (wt: ResolvedWorktree, error: unknown) => void;
}

export class WorktreeService {
  constructor(
    readonly roots: RepoRoots,
    private readonly options: () => WorktreeServiceOptions,
  ) {}

  async list(): Promise<ResolvedWorktree[]> {
    const worktrees = await resolveWorktrees(this.roots);
    const options = this.options();
    if (!options.autoAdopt) return worktrees;
    let adopted = false;
    for (const wt of worktrees) {
      if (!wt.isMain && wt.path && wt.insideRepo && !wt.portable) {
        try {
          adopted = (await makePortable(wt.path, wt.adminDir)) || adopted;
        } catch (error) {
          // One worktree we cannot adopt (EPERM, EACCES, ...) must not blank the whole overview.
          options.onAdoptError?.(wt, error);
        }
      }
    }
    return adopted ? resolveWorktrees(this.roots) : worktrees;
  }

  async listBranches(): Promise<BranchList> {
    const out = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: this.roots.mainRoot });
    const local: string[] = [];
    const remote: string[] = [];
    for (const ref of out.split(/\r?\n/)) {
      if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
      else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push(ref.slice('refs/remotes/'.length));
    }
    return { local, remote };
  }

  async create(req: CreateRequest): Promise<ResolvedWorktree> {
    const branch = req.kind === 'remote' ? (req.localBranch ?? req.remoteRef.split('/').slice(1).join('/')) : req.branch;
    const name = uniqueName(sanitizeName(branch), await existingNames(this.roots.mainRoot));
    const dir = path.join(worktreesRoot(this.roots.mainRoot), name);
    await ensureExcluded(this.roots.commonDir);
    const args =
      req.kind === 'new'
        ? ['worktree', 'add', '-b', branch, dir, req.startPoint ?? 'HEAD']
        : req.kind === 'existing'
          ? ['worktree', 'add', dir, branch]
          : ['worktree', 'add', '--track', '-b', branch, dir, req.remoteRef];
    await runGit(args, { cwd: this.roots.mainRoot, timeoutMs: ADD_TIMEOUT_MS });
    const value = await readGitFile(dir);
    if (!value) throw new Error(`git worktree add did not create ${path.join(dir, '.git')}`);
    const adminDir = resolveGitdir(dir, value);
    await makePortable(dir, adminDir);
    const created = (await resolveWorktrees(this.roots)).find((w) => samePath(w.adminDir, adminDir));
    if (!created) throw new Error(`Created worktree at ${dir} but could not resolve it.`);
    return created;
  }

  async adopt(wt: ResolvedWorktree): Promise<void> {
    if (!wt.path) throw new Error('This worktree is not reachable from this environment.');
    if (!(await makePortable(wt.path, wt.adminDir))) {
      throw new Error(`Cannot make ${wt.path} portable: there is no relative path to ${wt.adminDir} that git accepts.`);
    }
  }

  async removalRisks(wt: ResolvedWorktree): Promise<RemovalRisks> {
    let changedFiles = 0;
    let halfRemoved = false;
    if (wt.path) {
      const status = parseStatusV2(await runGit(['status', '--porcelain=v2', '-z'], { cwd: wt.path }));
      const staged = new Set(status.staged.map((c) => c.path));
      const untracked: string[] = [];
      let deleted = 0;
      let other = 0;
      for (const change of status.changes) {
        // An untracked link at the top is deleted as a link by remove(): nothing in it is lost.
        if (change.kind === 'untracked' && (await isTopLevelLink(wt.path, change.path))) continue;
        changedFiles++;
        if (change.kind === 'untracked') untracked.push(change.path);
        else if (change.kind === 'deleted' && !staged.has(change.path)) deleted++;
        else other++;
      }
      halfRemoved = deleted > 0 && other === 0 && (await countIgnoredByBranch(wt.path, untracked)) === untracked.length;
    }
    let unmergedCommits = 0;
    if (wt.branch) {
      const ref = `refs/heads/${wt.branch}`;
      const out = await runGit(['rev-list', '--count', ref, '--not', `--exclude=${wt.branch}`, '--branches', '--remotes'], { cwd: this.roots.mainRoot });
      unmergedCommits = Number(out.trim());
    }
    return { changedFiles, unmergedCommits, halfRemoved };
  }

  async remove(wt: ResolvedWorktree, opts: { force: boolean }): Promise<void> {
    if (wt.isMain) throw new Error('The main worktree cannot be removed.');
    if (!wt.path) throw new Error('This worktree is not reachable from this environment.');
    await retargetBackPointer(wt.path, wt.adminDir);
    // Untracked links to folders outside (a junction to the main node_modules) go first, as links: git is never
    // handed a worktree it could delete outside files through.
    const tracked = await runGit(['ls-files', '-z', '--', ':(top,glob)*'], { cwd: wt.path }).catch(() => '');
    await removeTopLevelLinks(wt.path, new Set(tracked.split('\0').filter(Boolean)));
    // Without force, git refuses a worktree with changes: then nothing is deleted.
    const clean = opts.force || !(await runGit(['status', '--porcelain', '-z'], { cwd: wt.path }).catch(() => '?'));
    if (clean) await deleteIgnoredFolders(wt.path);
    const previousLock = await readLock(wt.adminDir);
    await unlock(wt.adminDir);
    try {
      // Long paths (a VS Code download under .vscode-test goes past 260 characters): without them git stops halfway on
      // Windows, after it has already deleted the worktree's .git.
      await runGit(['-c', 'core.longpaths=true', 'worktree', 'remove', ...(opts.force ? ['--force'] : []), wt.path], {
        cwd: this.roots.mainRoot,
        timeoutMs: ADD_TIMEOUT_MS,
      });
    } catch (error) {
      if (previousLock !== undefined) {
        try {
          await lock(wt.adminDir, previousLock);
        } catch {
          // e.g. ENOENT when git already deleted the admin dir: the git error is what matters
        }
      }
      throw error;
    }
  }

  /**
   * Folders in .worktrees/ that are no worktree any more: no .git in them and git doesn't list them, left by a removal
   * that stopped halfway. One changed in the last LEFTOVER_MIN_AGE_MS is skipped (a worktree still being added).
   */
  async leftovers(now: number = Date.now()): Promise<string[]> {
    const root = worktreesRoot(this.roots.mainRoot);
    const known = (await resolveWorktrees(this.roots)).flatMap((w) => (w.path ? [w.path] : []));
    const result: string[] = [];
    for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (known.some((k) => samePath(k, dir))) continue;
      if (await fs.lstat(path.join(dir, '.git')).catch(() => undefined)) continue;
      const stat = await fs.stat(dir).catch(() => undefined);
      if (!stat || now - stat.mtimeMs < LEFTOVER_MIN_AGE_MS) continue;
      result.push(dir);
    }
    return result;
  }

  /** Deletes a folder leftovers() lists (checked again), links in it as links. */
  async deleteLeftover(dir: string): Promise<void> {
    if (!(await this.leftovers()).some((d) => samePath(d, dir))) throw new Error(`${dir} is not a leftover worktree folder.`);
    await removeTopLevelLinks(dir);
    // Not Electron's fs: it would open a VS Code download's .asar as a folder and keep it open (see rawFs).
    await rawFs().promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }

  /** Deletes git's record of a worktree that is unreachable here. Never touches worktree files. */
  async forget(wt: ResolvedWorktree): Promise<void> {
    if (wt.isMain || wt.path) throw new Error('Only worktrees that are unreachable from this environment can be forgotten.');
    await fs.rm(wt.adminDir, { recursive: true, force: true });
  }

  async deleteBranch(branch: string, force: boolean): Promise<void> {
    await runGit(['branch', force ? '-D' : '-d', branch], { cwd: this.roots.mainRoot });
  }
}
