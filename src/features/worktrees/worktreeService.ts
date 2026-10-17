import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit } from '../../core/git/gitCli';
import { parseStatusV2 } from '../../core/git/porcelain';
import { samePath } from '../../core/paths';
import { removeTopLevelLinks } from '../storage/finished';
import { ensureExcluded, existingNames, sanitizeName, uniqueName, worktreesRoot } from './layout';
import { lock, makePortable, readGitFile, readLock, resolveGitdir, retargetBackPointer, unlock } from './portability';
import { resolveWorktrees, type RepoRoots, type ResolvedWorktree } from './resolver';

export type CreateRequest =
  | { kind: 'new'; branch: string; startPoint?: string }
  | { kind: 'existing'; branch: string }
  | { kind: 'remote'; remoteRef: string; localBranch?: string };

export interface BranchList {
  local: string[];
  remote: string[];
}

export interface RemovalRisks {
  /** Uncommitted + untracked entries that would be deleted. */
  changedFiles: number;
  /** Commits only reachable from this worktree's branch. */
  unmergedCommits: number;
}

const ADD_TIMEOUT_MS = 120_000;

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
    if (wt.path) {
      changedFiles = parseStatusV2(await runGit(['status', '--porcelain=v2', '-z'], { cwd: wt.path })).changes.length;
    }
    let unmergedCommits = 0;
    if (wt.branch) {
      const ref = `refs/heads/${wt.branch}`;
      const out = await runGit(['rev-list', '--count', ref, '--not', `--exclude=${wt.branch}`, '--branches', '--remotes'], { cwd: this.roots.mainRoot });
      unmergedCommits = Number(out.trim());
    }
    return { changedFiles, unmergedCommits };
  }

  async remove(wt: ResolvedWorktree, opts: { force: boolean }): Promise<void> {
    if (wt.isMain) throw new Error('The main worktree cannot be removed.');
    if (!wt.path) throw new Error('This worktree is not reachable from this environment.');
    await retargetBackPointer(wt.path, wt.adminDir);
    // Untracked links to folders outside (a junction to the main node_modules) go first, as links: git is never
    // handed a worktree it could delete outside files through.
    const tracked = await runGit(['ls-files', '-z', '--', ':(top,glob)*'], { cwd: wt.path }).catch(() => '');
    await removeTopLevelLinks(wt.path, new Set(tracked.split('\0').filter(Boolean)));
    const previousLock = await readLock(wt.adminDir);
    await unlock(wt.adminDir);
    try {
      await runGit(['worktree', 'remove', ...(opts.force ? ['--force'] : []), wt.path], { cwd: this.roots.mainRoot, timeoutMs: ADD_TIMEOUT_MS });
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

  /** Deletes git's record of a worktree that is unreachable here. Never touches worktree files. */
  async forget(wt: ResolvedWorktree): Promise<void> {
    if (wt.isMain || wt.path) throw new Error('Only worktrees that are unreachable from this environment can be forgotten.');
    await fs.rm(wt.adminDir, { recursive: true, force: true });
  }

  async deleteBranch(branch: string, force: boolean): Promise<void> {
    await runGit(['branch', force ? '-D' : '-d', branch], { cwd: this.roots.mainRoot });
  }
}
