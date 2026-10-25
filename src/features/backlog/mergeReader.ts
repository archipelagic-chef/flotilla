import { runGit } from '../../core/git/gitCli';
import { branchMatches, itemBranches, type BacklogItem } from './backlog';
import { summarizeMerge, type BranchState, type MergeInfo } from './merged';

/**
 * Reads whether each item's branches are merged into the base, from git. A branch is merged when it's an ancestor of
 * the base and had commits of its own (its reflog says so: a branch just started is an ancestor too). Branches that
 * no longer exist are left out. Results are cached by the base's and each branch's commit, so a refresh with nothing
 * moved reads nothing.
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
    // Ancestor of the base: merged if it ever had commits (its reflog says more than its creation), else empty.
    const log = await runGit(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], { cwd: this.cwd }).catch(() => '');
    const worked = log.split('\n').some((line) => line && !line.startsWith('branch: Created'));
    return { branch, state: worked ? 'merged' : 'empty', commits: 0 };
  }
}
