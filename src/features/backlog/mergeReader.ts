import { runGit } from '../../core/git/gitCli';
import {
  type BacklogItem,
  branchMatches,
  itemBranches,
} from './backlog';
import {
  type BranchState,
  type MergeInfo,
  summarizeMerge,
} from './merged';

/**
 * Reads whether each item's branches are merged into the base, from git. A branch is merged when it's an ancestor of
 * the base and its tip is a commit it made itself (its reflog says so: a branch just started, or reset back, is an
 * ancestor too). Branches that no longer exist are left out. Results are cached by the base's and each branch's
 * commit, so a refresh with nothing moved reads nothing.
 */
export class MergeReader {
  private cache = new Map<string, BranchState>();

  constructor(private readonly cwd: string) {}

  /** The merge state of each item with branches (by id), against the base. Empty without a base. */
  async read(items: readonly BacklogItem[], base: string | undefined): Promise<Map<string, MergeInfo>> {
    const result = new Map<string, MergeInfo>();
    if (!base) return result;
    let baseSha: string;
    try {
      baseSha = (await runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: this.cwd })).trim();
    } catch {
      return result;
    }
    const heads = await this.heads();
    const next = new Map<string, BranchState>();
    for (const item of items) {
      const names = new Set([...itemBranches(item), ...[...heads.keys()].filter((b) => branchMatches(item, b))]);
      const branches: BranchState[] = [];
      for (const branch of names) {
        const sha = heads.get(branch);
        if (!sha || branch === base) continue;
        const key = `${baseSha} ${branch} ${sha}`;
        const state = next.get(key) ?? this.cache.get(key) ?? (await this.branchState(branch, sha, baseSha));
        next.set(key, state);
        branches.push(state);
      }
      if (branches.length)
        result.set(
          item.id,
          summarizeMerge(
            base,
            branches.sort((a, b) => a.branch.localeCompare(b.branch)),
          ),
        );
    }
    // Only the branches read now stay cached: a branch that moved (or was deleted) has a new key.
    this.cache = next;
    return result;
  }

  /** Local branches and their commits. */
  private async heads(): Promise<Map<string, string>> {
    const out = await runGit(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { cwd: this.cwd }).catch(() => '');
    return new Map(
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const i = line.lastIndexOf(' ');
          return [line.slice(0, i), line.slice(i + 1)] as const;
        }),
    );
  }

  private async branchState(branch: string, sha: string, baseSha: string): Promise<BranchState> {
    const ancestor = await runGit(['merge-base', '--is-ancestor', sha, baseSha], { cwd: this.cwd }).then(
      () => true,
      () => false,
    );
    if (!ancestor) {
      const commits = Number((await runGit(['rev-list', '--count', `${baseSha}..${sha}`], { cwd: this.cwd })).trim()) || 0;
      return { branch, state: 'unmerged', commits };
    }
    // Ancestor of the base: merged if the branch made its tip itself (its reflog says so), else empty. A branch
    // back on the commit it was created from, reset to or fast-forwarded to is in the base too, with no work of its own;
    // so is one rebased with nothing of its own onto the base (Update from Main on a branch without commits, BL-284).
    const log = await runGit(['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`], { cwd: this.cwd }).catch(() => '');
    const worked = log.split('\n').some((line) => line.startsWith(`${sha} `) && madeCommit(line.slice(sha.length + 1), sha));
    return { branch, state: worked ? 'merged' : 'empty', commits: 0 };
  }
}

/** Whether a reflog entry's subject is the branch making a commit (sha): a commit, amend, rebase, cherry-pick, revert
 * or real merge, not its creation, a reset, a fast-forward, or a rebase that ended on the commit it was onto (it had
 * no commits of its own to replay, so its tip is the base's commit, not one it made). */
function madeCommit(subject: string, sha: string): boolean {
  const onto = /\(finish\): \S+ onto ([0-9a-f]{7,})$/.exec(subject)?.[1];
  if (onto && sha.startsWith(onto)) return false;
  if (/^(commit|cherry-pick|revert|rebase|am)\b/.test(subject)) return true;
  return /^(merge|pull)\b/.test(subject) && !/: Fast-forward$/.test(subject);
}
