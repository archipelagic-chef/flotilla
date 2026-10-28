import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { Repository } from '../../core/repository';
import { itemBranches, type BacklogItem } from '../../features/backlog/backlog';
import { gitHubRepo } from '../../features/backlog/sources/github';
import {
  isLocalUrl,
  PUSH_REMOTE,
  pushBranch,
  pushedInfo,
  pushNote,
  pushOnApproval,
  type PushResult,
  type PushSetting,
} from '../../features/backlog/branchPush';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { entryDate, whenItsDone } from '../../features/backlog/ticket';
import {
  closeDiscarded,
  ensurePullRequest,
  type GitHubPullRequests,
  GitHubSignInNeeded,
  pullRequestBody,
  type PullRequestInfo,
  pullRequestNote,
  type PullRequestSetting,
  settleMerged,
} from '../../features/ci/pullRequests';
import type { Workstream } from '../../features/workstreams/workstream';

export interface BranchPushDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  mainRoot: string;
  /** Only the leading window pushes (and notes it in the tickets). */
  isLeader: () => boolean;
  output: vscode.OutputChannel;
  /** The fake GitHub is on (flotilla.dev.githubApi): only a local origin is pushed to, never the network (BL-113). */
  localOnly?: boolean;
  /** The pull requests client of a GitHub repository (BL-221): none, no pull requests. */
  pullRequests?: (owner: string, repo: string) => GitHubPullRequests;
  /** The branch tickets merge into, which their pull requests go into. */
  baseBranch?: () => Promise<string | undefined>;
  /** A pull request couldn't be opened because you aren't signed in to GitHub (BL-232): asked once until you sign in. */
  needsSignIn?: () => void;
}

/** An approved ticket, not merged yet: its branches are pushed. */
export const pushable = (i: BacklogItem): boolean => i.status === 'review' && i.review?.state === 'approved' && !i.proposed && !i.merged && !i.discarded;

/** A ticket whose agent reported "Ready for review", not merged yet: with pull requests on, its branches are pushed (BL-221). */
export const inReview = (i: BacklogItem): boolean => i.status === 'review' && !i.proposed && !i.merged && !i.discarded;

/** A merged ticket whose pull request GitHub doesn't show as merged (or closed) yet. */
export const unsettled = (i: BacklogItem): boolean => !!i.merged && !!i.pullRequests?.some((p) => p.state === 'open');

/** A discarded ticket with a pull request still open on GitHub: it's closed (BL-225). */
export const discardedOpen = (i: BacklogItem): boolean => !!i.discarded && !i.merged && !!i.pullRequests?.some((p) => p.state === 'open');

/** The pull requests client for origin, when they're on (flotilla.github.pullRequests) and origin is on GitHub. */
export function originPullRequests(
  url: string,
  setting: PullRequestSetting,
  make: ((owner: string, repo: string) => GitHubPullRequests) | undefined,
): GitHubPullRequests | undefined {
  if (setting === 'off' || !make) return undefined;
  const gh = gitHubRepo(url);
  if (!gh) return undefined;
  try {
    return make(gh.owner, gh.repo);
  } catch {
    return undefined;
  }
}

/** The item's pull requests, with one of a branch put in. */
const withPullRequest = (i: BacklogItem, pr: PullRequestInfo): PullRequestInfo[] => [...(i.pullRequests ?? []).filter((p) => p.branch !== pr.branch), pr];

/**
 * Pushes approved tickets' branches to origin so CI runs on them before Merge to main (BL-104): when a ticket is
 * approved, and again when its branch gets new commits while it's approved. Each tip is pushed (or refused) once: the
 * last one is kept on the item, and the ticket notes it. flotilla.ci.pushOnApproval turns it off.
 *
 * With pull requests on (flotilla.github.pullRequests, BL-221), a ticket's branches are pushed once its agent reports
 * "Ready for review", and each gets a pull request into the base branch; once the ticket is merged, its pull requests
 * are marked merged by GitHub, or closed by Flotilla when other commits landed. A discarded ticket's open pull requests
 * are closed (BL-225); reopened and in review again, it gets new ones. Without a GitHub sign-in, you're asked once and
 * the tickets show it; once you sign in, their pull requests are opened (BL-232).
 */
export class BranchPush implements vscode.Disposable {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  /** Approved since their last push: pushed again even at the same tip (after a failure, say). */
  private readonly fresh = new Set<string>();
  /** The tips a pull request couldn't be opened for (branch → tip): tried again on the next tip, or when approved. */
  private readonly prFailed = new Map<string, string>();
  /** You were asked to sign in to GitHub (needsSignIn), and haven't signed in since. */
  private signInAsked = false;

  constructor(private readonly deps: BranchPushDeps) {
    // The repository's refresh sees new commits on the branches.
    this.subscriptions.push(deps.repository.onDidChange(() => this.schedule()));
    // A ticket going to review (its agent reported "Ready for review") gets its pull request (BL-221).
    this.subscriptions.push(deps.backlog.watch((changed) => (changed.has('backlog.json') || changed.has('*')) && this.schedule()));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
  }

  /** An item was approved: its branches are pushed now. */
  approved(id: string): void {
    this.fresh.add(id);
    this.schedule(0);
  }

  /** You signed in to GitHub (BL-232): the pull requests that couldn't be opened are opened now, at the same tips. */
  signedIn(): void {
    this.signInAsked = false;
    this.prFailed.clear();
    this.schedule(0);
  }

  /** A push soon: a burst of changes pushes once. */
  schedule(delayMs = 5000): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), delayMs);
  }

  async check(): Promise<void> {
    if (!this.deps.isLeader()) return;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.checkNow()
      .catch((e: unknown) => this.deps.output.appendLine(`Pushing approved branches: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.schedule(0);
        }
      });
    return this.running;
  }

  private async checkNow(): Promise<void> {
    const cwd = this.deps.mainRoot;
    const all = (await this.deps.backlog.read()).items;
    const fresh = new Set(this.fresh);
    this.fresh.clear();
    if (!all.some((i) => pushable(i) || inReview(i) || unsettled(i) || discardedOpen(i))) return;
    const url = (await runGit(['remote', 'get-url', '--push', PUSH_REMOTE], { cwd }).catch(() => '')).trim();
    if (this.deps.localOnly && !isLocalUrl(url)) {
      this.deps.output.appendLine(`Push: off, the fake GitHub is on and origin (${url}) isn't local.`);
      return;
    }
    const config = vscode.workspace.getConfiguration('flotilla');
    const onApproval = await pushOnApproval(cwd, config.get<PushSetting>('ci.pushOnApproval', 'auto'));
    const prs = this.pullRequestsClient(url, config.get<PullRequestSetting>('github.pullRequests', 'auto'));
    const items = all.filter((i) => (prs && inReview(i)) || (onApproval && pushable(i)));
    for (const item of items) {
      for (const branch of itemBranches(item)) {
        const tip = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd }).catch(() => '')).trim();
        if (!tip) continue;
        let last = item.pushed?.find((p) => p.branch === branch);
        if (last?.commit !== tip || fresh.has(item.id)) {
          last = pushedInfo(await pushItemBranch(this.deps, item, branch));
        }
        if (prs && !last.error) await this.openPullRequest(prs, item, branch, tip, fresh.has(item.id));
      }
    }
    if (prs) for (const item of all.filter(unsettled)) await this.settle(prs, item);
    if (prs) for (const item of all.filter(discardedOpen)) await this.closeForDiscarded(prs, item);
  }

  private pullRequestsClient(url: string, setting: PullRequestSetting): GitHubPullRequests | undefined {
    return originPullRequests(url, setting, this.deps.pullRequests);
  }

  /** A pushed branch's open pull request into the base branch: the one it has, or a new one, kept on the item and noted. */
  private async openPullRequest(prs: GitHubPullRequests, item: BacklogItem, branch: string, tip: string, again: boolean): Promise<void> {
    if (item.pullRequests?.some((p) => p.branch === branch && p.state === 'open')) return;
    if (this.prFailed.get(branch) === tip && !again) return;
    const base = await this.deps.baseBranch?.().catch(() => undefined);
    if (!base || base === branch) return;
    try {
      const ticket = await this.deps.backlog.readTicket(item);
      const { pr, created } = await ensurePullRequest(prs, {
        branch,
        base,
        title: item.title,
        body: pullRequestBody(item.id, item.title, whenItsDone(ticket.description)),
      });
      this.prFailed.delete(branch);
      this.deps.output.appendLine(`Pull request: #${pr.number} for ${branch} (${item.id})${created ? ', opened' : ''}.`);
      await this.keep(item.id, pr);
      await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: pullRequestNote(pr, created) });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.deps.output.appendLine(`Pull request for ${branch}: ${why}`);
      const noted = this.prFailed.get(branch) === tip;
      this.prFailed.set(branch, tip);
      if (e instanceof GitHubSignInNeeded) return this.signInNeeded(item, branch, why);
      if (!noted)
        await this.deps.backlog.appendActivity(item, {
          date: entryDate(new Date()),
          author: 'Flotilla',
          body: `Couldn't open a pull request for \`${branch}\` on GitHub: ${why}\n\nIt's tried again when the branch gets new commits.`,
        });
    }
  }

  /** No GitHub session: the ticket notes it once and shows it until its pull request opens; you're asked once. */
  private async signInNeeded(item: BacklogItem, branch: string, why: string): Promise<void> {
    if (!this.signInAsked) {
      this.signInAsked = true;
      this.deps.needsSignIn?.();
    }
    if ((await this.deps.backlog.read()).items.find((i) => i.id === item.id)?.pullRequestSignIn) return;
    await this.deps.backlog.change(
      (d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, pullRequestSignIn: new Date().toISOString() } : i)) }),
      {
        by: 'Flotilla',
      },
    );
    await this.deps.backlog.appendActivity(item, {
      date: entryDate(new Date()),
      author: 'Flotilla',
      body: `Couldn't open a pull request for \`${branch}\` on GitHub: ${why}\n\nIt's opened once you sign in.`,
    });
  }

  /** A merged ticket's open pull requests: merged by GitHub, or closed once main is on origin with other commits. */
  private async settle(prs: GitHubPullRequests, item: BacklogItem): Promise<void> {
    const cwd = this.deps.mainRoot;
    const merged = item.merged!;
    const onOrigin = (commit: string) =>
      runGit(['merge-base', '--is-ancestor', commit, `refs/remotes/${PUSH_REMOTE}/${merged.into}`], { cwd }).then(
        () => true,
        () => false,
      );
    for (const pr of item.pullRequests?.filter((p) => p.state === 'open') ?? []) {
      const head = item.pushed?.find((p) => p.branch === pr.branch && !p.error)?.commit;
      try {
        const now = await settleMerged(prs, pr, {
          commit: merged.commit,
          base: merged.into,
          onOrigin: await onOrigin(merged.commit),
          headOnOrigin: !!head && (await onOrigin(head)),
        });
        if (now.state === pr.state) continue;
        await this.keep(item.id, now);
        this.deps.output.appendLine(`Pull request: #${now.number} (${item.id}) ${now.state}.`);
        if (now.state === 'closed')
          await this.deps.backlog.appendActivity(item, {
            date: entryDate(new Date()),
            author: 'Flotilla',
            body: `Closed pull request [#${now.number}](${now.url}): it landed on \`${merged.into}\` as \`${merged.commit.slice(0, 7)}\`, with other commits than its own.`,
          });
      } catch (e) {
        this.deps.output.appendLine(`Pull request #${pr.number} (${item.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** A discarded ticket's open pull requests: closed with a comment, and noted in the ticket. */
  private async closeForDiscarded(prs: GitHubPullRequests, item: BacklogItem): Promise<void> {
    for (const pr of item.pullRequests?.filter((p) => p.state === 'open') ?? []) {
      try {
        const now = await closeDiscarded(prs, pr, item.id);
        await this.keep(item.id, now);
        this.deps.output.appendLine(`Pull request: #${now.number} (${item.id}) ${now.state}, the ticket was discarded.`);
        if (now.state === 'closed')
          await this.deps.backlog.appendActivity(item, {
            date: entryDate(new Date()),
            author: 'Flotilla',
            body: `Closed pull request [#${now.number}](${now.url}) on GitHub: the ticket was discarded.`,
          });
      } catch (e) {
        this.deps.output.appendLine(`Pull request #${pr.number} (${item.id}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async keep(id: string, pr: PullRequestInfo): Promise<void> {
    await this.deps.backlog.change(
      (d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, pullRequests: withPullRequest(i, pr), pullRequestSignIn: undefined } : i)) }),
      {
        by: 'Flotilla',
      },
    );
  }
}

/** With the fake GitHub on, only a local origin is pushed to (BL-113): false (and why, in the output) otherwise. */
export async function originIsLocal(cwd: string, output: vscode.OutputChannel): Promise<boolean> {
  const url = (await runGit(['remote', 'get-url', '--push', PUSH_REMOTE], { cwd }).catch(() => '')).trim();
  if (isLocalUrl(url)) return true;
  output.appendLine(`Push: off, the fake GitHub is on and origin (${url}) isn't local.`);
  return false;
}

/**
 * Pushes one of an item's branches to origin (pushBranch's checks, leased on its last push), keeps the result on the
 * item and notes it in the ticket: on approval (BranchPush) and from a ticket's Run CI (BL-222).
 */
export async function pushItemBranch(deps: Pick<BranchPushDeps, 'backlog' | 'mainRoot' | 'output'>, item: BacklogItem, branch: string): Promise<PushResult> {
  const last = item.pushed?.find((p) => p.branch === branch);
  deps.output.appendLine(`Push: ${branch} (${item.id}) to origin.`);
  const result = await pushBranch(deps.mainRoot, branch, { leased: last && !last.error ? last.commit : undefined });
  deps.output.appendLine(`Push: ${branch}: ${result.kind}${result.kind === 'failed' ? `: ${result.reason}` : ''}`);
  await deps.backlog.change(
    (d) => ({
      ...d,
      items: d.items.map((i) => (i.id === item.id ? { ...i, pushed: [...(i.pushed ?? []).filter((p) => p.branch !== branch), pushedInfo(result)] } : i)),
    }),
    { by: 'Flotilla' },
  );
  const note = pushNote(result);
  if (note) await deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: note });
  return result;
}
