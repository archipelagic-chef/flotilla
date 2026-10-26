import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import type { BacklogItem } from '../../features/backlog/backlog';
import { PUSH_REMOTE } from '../../features/backlog/branchPush';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { commentEntries, planPosts } from '../../features/ci/prComments';
import type { GitHubPullRequests, PullRequestInfo, PullRequestSetting } from '../../features/ci/pullRequests';
import { originPullRequests } from './branchPush';

export interface PullRequestCommentsDeps {
  backlog: LocalBacklog;
  mainRoot: string;
  /** Only the leading window syncs (one window posts each comment). */
  isLeader: () => boolean;
  output: vscode.OutputChannel;
  pullRequests?: (owner: string, repo: string) => GitHubPullRequests;
  /** The tickets whose tabs show now: their pull requests are read more often. */
  shown: () => string[];
  /** How often a shown ticket's pull request is read, and every one with the CI reads at most. */
  shownMs?: number;
  allMs?: number;
  /** How long after a ticket's file changes its new entries are posted. */
  changedMs?: number;
}

/** A ticket with a pull request to sync: open on GitHub, the ticket not merged. */
const syncing = (i: BacklogItem): boolean => !i.merged && !i.proposed && !!i.pullRequests?.some((p) => p.state === 'open');

/**
 * A ticket's activity and its pull request's comments, both ways (BL-224): read while its tab shows (every 15 seconds),
 * with the CI reads otherwise (once a minute at most), and soon after the ticket's file changes (a comment of yours, an
 * agent's report).
 */
export class PullRequestComments implements vscode.Disposable {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly timer: NodeJS.Timeout;
  private readonly changed = new Map<string, NodeJS.Timeout>();
  private queue: Promise<void> = Promise.resolve();
  private lastAll = 0;

  constructor(private readonly deps: PullRequestCommentsDeps) {
    this.subscriptions.push(
      deps.backlog.watch((names) => {
        for (const name of names) {
          const id = /^([A-Za-z][\w-]*)\.md$/.exec(name)?.[1];
          if (id) this.soon(id);
        }
      }),
    );
    this.timer = setInterval(() => {
      const shown = this.deps.shown();
      if (shown.length) void this.sync(shown);
    }, deps.shownMs ?? 15_000);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.changed.forEach((t) => clearTimeout(t));
    this.subscriptions.forEach((s) => s.dispose());
  }

  /** The CI was read: every ticket's pull request is read too, once a minute at most. */
  ciRead(): void {
    if (Date.now() - this.lastAll < (this.deps.allMs ?? 60_000)) return;
    this.lastAll = Date.now();
    void this.sync();
  }

  /** A ticket's file changed: its new entries are posted soon (a burst of changes once). */
  private soon(id: string): void {
    clearTimeout(this.changed.get(id));
    this.changed.set(
      id,
      setTimeout(() => {
        this.changed.delete(id);
        void this.sync([id]);
      }, this.deps.changedMs ?? 3000),
    );
  }

  /** Syncs the tickets (all with an open pull request when none are named), one sync after another. */
  sync(ids?: string[]): Promise<void> {
    this.queue = this.queue
      .then(() => this.syncNow(ids))
      .catch((e: unknown) => this.deps.output.appendLine(`Pull request comments: ${e instanceof Error ? e.message : String(e)}`));
    return this.queue;
  }

  private async syncNow(ids: string[] | undefined): Promise<void> {
    if (!this.deps.isLeader()) return;
    const items = (await this.deps.backlog.read()).items.filter((i) => syncing(i) && (!ids || ids.includes(i.id)));
    if (!items.length) return;
    const cwd = this.deps.mainRoot;
    const url = (await runGit(['remote', 'get-url', '--push', PUSH_REMOTE], { cwd }).catch(() => '')).trim();
    const setting = vscode.workspace.getConfiguration('flotilla').get<PullRequestSetting>('github.pullRequests', 'auto');
    const prs = originPullRequests(url, setting, this.deps.pullRequests);
    if (!prs) return;
    for (const item of items)
      for (const pr of item.pullRequests!.filter((p) => p.state === 'open')) {
        try {
          await this.syncPullRequest(prs, item, pr);
        } catch (e) {
          this.deps.output.appendLine(`Pull request #${pr.number} (${item.id}) comments: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
  }

  private async syncPullRequest(prs: GitHubPullRequests, item: BacklogItem, pr: PullRequestInfo): Promise<void> {
    const { backlog, output } = this.deps;
    const comments = await prs.comments(pr.number);
    // In: the comments the ticket doesn't have yet, as it is when written.
    if (commentEntries((await backlog.readTicket(item)).activity, comments).length) {
      let added = 0;
      await backlog.editTicket(item, (ticket) => {
        const entries = commentEntries(ticket.activity, comments);
        added = entries.length;
        return { ...ticket, activity: [...ticket.activity, ...entries] };
      });
      output.appendLine(`Pull request #${pr.number} (${item.id}): ${added} comment${added === 1 ? '' : 's'} from GitHub.`);
    }
    // Out: the entries to post, and the comments their entries' edits and deletions change.
    const key = `${item.id}#${pr.number}`;
    const before = await backlog.pullRequestComments(key);
    const plan = planPosts({ id: item.id, activity: (await backlog.readTicket(item)).activity, comments, known: before });
    const failed = new Set<string>();
    for (const p of plan.posts) {
      try {
        await prs.addComment(pr.number, p.body, p.inReplyTo);
        output.appendLine(`Pull request #${pr.number} (${item.id}): posted ${p.anchor}.`);
      } catch (e) {
        // Tried again on the next sync.
        failed.add(p.anchor);
        output.appendLine(`Pull request #${pr.number} (${item.id}): posting ${p.anchor}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const e of plan.edits)
      await prs.editComment(e.comment.kind, e.comment.id, e.body).catch((err: unknown) => output.appendLine(`Editing ${e.anchor}'s comment: ${String(err)}`));
    for (const d of plan.deletes)
      await prs
        .deleteComment(d.comment.kind, d.comment.id)
        .catch((err: unknown) => !String(err).includes('404') && output.appendLine(`Deleting ${d.anchor}'s comment: ${String(err)}`));
    const known = plan.known.filter((a) => !failed.has(a));
    if (!before || known.length !== before.length) await backlog.setPullRequestComments(key, known);
  }
}
