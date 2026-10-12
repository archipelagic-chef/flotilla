import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import { gitHubName, gitHubRepo } from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import { GitHubActions, isActive, splitUpstream, type CiRun } from '../../features/ci/githubActions';
import { anyRunActive, ciStamp, refreshDelay } from '../../features/ci/refresh';
import { runActions, type RunAction } from '../../features/ci/runActions';
import type { Workstream } from '../../features/workstreams/workstream';
import type { CiView } from '../../webview/protocol';

const SCOPES = ['repo'];
/** How long after a re-run or cancel GitHub is read again, for the state it has settled into. */
const FOLLOW_UP_MS = 3_000;

/** Where a worktree's runs are: its branch on a GitHub repository, or the view that says why there are none. */
type Where = { kind: 'github'; owner: string; repo: string; branch: string } | { kind: 'view'; view: CiView };

type Session = Pick<vscode.AuthenticationSession, 'accessToken'>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The CI/CD view's data: the latest workflow runs of each worktree's branch on GitHub, read through the user's GitHub
 * sign-in. Read at once when the sidebar shows and when a worktree's commit or upstream moves (a push), then every
 * minute while it's shown (every 10 seconds while a run goes on); nothing while it's hidden.
 */
export class CiRuns implements vscode.Disposable {
  private views = new Map<string, CiView>();
  private workstreams: readonly Workstream[] = [];
  private stamps = new Map<string, string>();
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private followUp: ReturnType<typeof setTimeout> | undefined;

  /** post sends the views of every worktree to the sidebar. */
  constructor(private readonly post: (views: Record<string, CiView>) => void) {}

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.followUp);
  }

  /** The worktrees changed: the ones whose commit or upstream moved are read again (while shown). */
  update(workstreams: readonly Workstream[]): void {
    const moved = workstreams.filter((ws) => this.stamps.get(ws.key) !== ciStamp(ws));
    this.workstreams = workstreams;
    for (const ws of workstreams) this.stamps.set(ws.key, ciStamp(ws));
    const gone = [...this.views.keys()].filter((key) => !workstreams.some((ws) => ws.key === key));
    for (const key of gone) this.views.delete(key);
    if (this.visible && moved.length) void this.load(moved.map((ws) => ws.key));
    else if (gone.length) this.post(this.snapshot());
  }

  /** The sidebar is shown (reads now, then regularly) or hidden (nothing is read). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) void this.load();
    else clearTimeout(this.timer);
  }

  /**
   * Re-runs a run (or only its failed jobs), or cancels it, from the view: the run must be one the view shows and be
   * offered its action. A cancel asks first. Then the worktree's runs are read again.
   */
  async act(key: string, runId: number, action: RunAction): Promise<void> {
    const view = this.views.get(key);
    const run = view?.kind === 'runs' ? view.runs.find((r) => r.id === runId) : undefined;
    if (view?.kind !== 'runs' || !run) throw new Error("That run isn't in this worktree's CI/CD view any more. Refresh the view and try again.");
    if (!runActions({ active: isActive(run.status), failed: run.status === 'failure' }).includes(action)) {
      throw new Error(`This run can't be ${action === 'cancel' ? 'cancelled' : 're-run this way'} now. Refresh the view to see its state.`);
    }
    if (action === 'cancel') {
      const answer = await vscode.window.showWarningMessage(`Cancel ${run.workflow} #${run.number} on ${view.branch}?`, { modal: true }, 'Cancel run');
      if (answer !== 'Cancel run') return;
    }
    // A dismissed sign-in dialog ends it: nothing was asked of GitHub.
    const session = await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then((s) => s, () => undefined);
    if (!session) return;
    const [owner, repo] = view.repo.split('/');
    const github = new GitHubActions(owner, repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch);
    if (action === 'cancel') await github.cancel(runId);
    else await github.rerun(runId, action === 'rerunFailed');
    await this.load([key]);
    // GitHub can take a moment to show the new attempt or the cancelled run: read once more shortly after.
    clearTimeout(this.followUp);
    this.followUp = setTimeout(() => void this.load([key]), FOLLOW_UP_MS);
  }

  /** Reads every worktree's runs now. */
  refresh(): Promise<void> {
    return this.load();
  }

  /** Asks for the GitHub sign-in (a dialog, unlike the silent reads), then reads the runs. */
  async signIn(): Promise<void> {
    // A dismissed dialog is not an error: the view stays at "Sign in to GitHub".
    await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then(undefined, () => undefined);
    await this.load();
  }

  /** The views as last read, of the worktrees there are now (sent to a sidebar that has just loaded). */
  snapshot(): Record<string, CiView> {
    return Object.fromEntries([...this.views].filter(([key]) => this.workstreams.some((ws) => ws.key === key)));
  }

  private async load(keys?: string[]): Promise<void> {
    clearTimeout(this.timer);
    const targets = this.workstreams.filter((ws) => !keys || keys.includes(ws.key));
    const wheres = await Promise.all(targets.map(async (ws) => ({ ws, where: await this.where(ws) })));
    const github = wheres.some((w) => w.where.kind === 'github');
    // Without a sign-in (or a provider to ask), the runs say so: they're not read.
    const session = github ? await vscode.authentication.getSession('github', SCOPES, { silent: true }).then((s) => s, () => undefined) : undefined;
    // Worktrees on the same branch share one read.
    const reads = new Map<string, Promise<CiRun[]>>();
    await Promise.all(
      wheres.map(async ({ ws, where }) => {
        const view = await this.viewOf(ws, where, session, reads);
        // A worktree removed while its runs were read has no view any more.
        if (this.workstreams.some((w) => w.key === ws.key)) this.views.set(ws.key, view);
      }),
    );
    this.post(this.snapshot());
    // The last load to finish sets the next one (a load that overlapped another doesn't leave a second timer running).
    // Only the worktrees there are now count: a run on a removed one doesn't keep the timer short.
    const anyActive = anyRunActive(Object.values(this.snapshot()).flatMap((v) => (v.kind === 'runs' ? v.runs : [])));
    const delay = refreshDelay(this.visible, anyActive);
    clearTimeout(this.timer);
    this.timer = delay === undefined ? undefined : setTimeout(() => void this.load(), delay);
  }

  /** Where a worktree's runs are: its branch on GitHub, or the view that says why there are none. */
  private async where(ws: Workstream): Promise<Where> {
    const cwd = ws.worktree.path;
    // Every worktree gets a view, so the All tab never waits on one that can't be read.
    if (!cwd) return { kind: 'view', view: { kind: 'error', error: "This worktree's folder isn't reachable from this environment." } };
    const upstream = ws.sync.upstream;
    if (!upstream) return { kind: 'view', view: { kind: 'unpublished' } };
    try {
      const remotes = (await runGit(['remote'], { cwd })).split('\n').filter(Boolean);
      const split = splitUpstream(upstream, remotes);
      if (!split) return { kind: 'view', view: { kind: 'error', error: `The upstream ${upstream} is not on a remote of this repository.` } };
      const gh = gitHubRepo((await runGit(['remote', 'get-url', split.remote], { cwd })).trim());
      if (!gh || !gitHubName(gh.owner) || !gitHubName(gh.repo)) return { kind: 'view', view: { kind: 'unsupported' } };
      return { kind: 'github', owner: gh.owner, repo: gh.repo, branch: split.branch };
    } catch (error) {
      return { kind: 'view', view: { kind: 'error', error: message(error) } };
    }
  }

  private async viewOf(ws: Workstream, where: Where, session: Session | undefined, reads: Map<string, Promise<CiRun[]>>): Promise<CiView> {
    if (where.kind === 'view') return where.view;
    if (!session) return { kind: 'signIn' };
    const { owner, repo, branch } = where;
    const token = session.accessToken;
    const id = `${owner}/${repo}@${branch}`;
    try {
      let read = reads.get(id);
      if (!read) {
        read = new GitHubActions(owner, repo, async () => token, globalThis.fetch as unknown as Fetch).runs(branch);
        reads.set(id, read);
      }
      const runs = await read;
      // The runs of the commit checked out here are marked.
      return { kind: 'runs', repo: `${owner}/${repo}`, branch, runs: runs.map((r) => ({ ...r, current: r.sha === ws.sync.head })) };
    } catch (error) {
      return { kind: 'error', error: message(error) };
    }
  }
}
