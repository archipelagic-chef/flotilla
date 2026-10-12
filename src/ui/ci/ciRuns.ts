import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import { gitHubName, gitHubRepo } from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import { GitHubActions, isActive, splitUpstream, type CiJob, type CiRun, type CiStatus } from '../../features/ci/githubActions';
import { GitHubDeployments, type CiDeployment } from '../../features/ci/githubDeployments';
import { anyDeploymentActive, anyRunActive, ciStamp, jobsDue, refreshDelay } from '../../features/ci/refresh';
import { runActions, type RunAction } from '../../features/ci/runActions';
import type { Workstream } from '../../features/workstreams/workstream';
import type { CiRunView, CiView } from '../../webview/protocol';

const SCOPES = ['repo'];
/** How long after a re-run or cancel GitHub is read again, for the state it has settled into. */
const FOLLOW_UP_MS = 3_000;
/** What the fake GitHub is sent instead of the sign-in's token: it doesn't check it, and it's never a real one. */
const FAKE_TOKEN = 'fake-token';

/** Where a worktree's runs are: its branch on a GitHub repository, or the view that says why there are none. */
type Where = { kind: 'github'; owner: string; repo: string; branch: string } | { kind: 'view'; view: CiView };

type Session = Pick<vscode.AuthenticationSession, 'accessToken'>;

/** A run's jobs as last read, and the status of the run then (a run that has moved on is read again). */
interface JobsState {
  status: CiStatus;
  jobs?: CiJob[];
  error?: string;
}

/** A branch as GitHub answers: its runs, and its deployments (which can fail apart from the runs). */
interface BranchRead {
  runs: CiRun[];
  deployments: CiDeployment[];
  deploymentsError?: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A branch's runs and deployments. The runs' error is the view's; a deployments error stays with the deployments. */
async function readBranch(owner: string, repo: string, branch: string, token: () => Promise<string>, api?: string): Promise<BranchRead> {
  const fetch = globalThis.fetch as unknown as Fetch;
  const runs = new GitHubActions(owner, repo, token, fetch, api).runs(branch);
  const deployments = new GitHubDeployments(owner, repo, token, fetch, api).forBranch(branch).then(
    (found) => ({ deployments: found }),
    (error: unknown) => ({ deployments: [], deploymentsError: message(error) }),
  );
  const [read, found] = await Promise.all([runs, deployments]);
  return { runs: read, ...found };
}

/**
 * The CI/CD view's data: the latest workflow runs of each worktree's branch on GitHub, read through the user's GitHub
 * sign-in. Read at once when the sidebar shows and when a worktree's commit or upstream moves (a push), then every
 * minute while it's shown (every 10 seconds while a run goes on); nothing while it's hidden.
 */
export class CiRuns implements vscode.Disposable {
  private views = new Map<string, CiView>();
  private workstreams: readonly Workstream[] = [];
  private stamps = new Map<string, string>();
  /** The runs the user expanded, per worktree: their jobs are read. */
  private expanded = new Map<string, Set<number>>();
  private jobs = new Map<string, Map<number, JobsState>>();
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** One read per worktree, a few seconds after its run was acted on (each action has its own). */
  private followUps = new Map<string, ReturnType<typeof setTimeout>>();
  /** The actions on their way (a click on one already sent or asking is ignored). */
  private acting = new Set<string>();

  /** post sends the views of every worktree to the sidebar; api, when set, is the fake GitHub (no sign-in then). */
  constructor(
    private readonly post: (views: Record<string, CiView>) => void,
    private readonly api?: string,
  ) {}

  dispose(): void {
    clearTimeout(this.timer);
    for (const timer of this.followUps.values()) clearTimeout(timer);
    this.followUps.clear();
  }

  /** The worktrees changed: the ones whose commit or upstream moved are read again (while shown). */
  update(workstreams: readonly Workstream[]): void {
    const moved = workstreams.filter((ws) => this.stamps.get(ws.key) !== ciStamp(ws));
    this.workstreams = workstreams;
    for (const ws of workstreams) this.stamps.set(ws.key, ciStamp(ws));
    const gone = [...this.views.keys()].filter((key) => !workstreams.some((ws) => ws.key === key));
    for (const key of gone) {
      this.views.delete(key);
      this.expanded.delete(key);
      this.jobs.delete(key);
      clearTimeout(this.followUps.get(key));
      this.followUps.delete(key);
    }
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
    const flight = `${key}\n${runId}`;
    if (this.acting.has(flight)) return;
    this.acting.add(flight);
    let asked = false;
    try {
      if (action === 'cancel') {
        const answer = await vscode.window.showWarningMessage(`Cancel ${run.workflow} #${run.number} on ${view.branch}?`, { modal: true }, 'Cancel run');
        if (answer !== 'Cancel run') return;
      }
      // A dismissed sign-in dialog ends it: nothing was asked of GitHub. The fake GitHub needs no sign-in, and never gets a real token.
      const session: Session | undefined = this.api
        ? { accessToken: FAKE_TOKEN }
        : await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then((s) => s, () => undefined);
      if (!session) return;
      const [owner, repo] = view.repo.split('/');
      const github = new GitHubActions(owner, repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch, this.api);
      asked = true;
      if (action === 'cancel') await github.cancel(runId);
      else await github.rerun(runId, action === 'rerunFailed');
    } finally {
      this.acting.delete(flight);
      // Read the runs again even when GitHub refused: a refusal ("already finished") is when the view is most out of date.
      if (asked) {
        await this.load([key]);
        this.followUpRead(key);
      }
    }
  }

  /** GitHub can take a moment to show the new attempt or the cancelled run: read the worktree once more shortly after. */
  private followUpRead(key: string): void {
    clearTimeout(this.followUps.get(key));
    this.followUps.set(
      key,
      setTimeout(() => {
        this.followUps.delete(key);
        // Nothing is read while the sidebar is hidden, and a worktree that was removed has no runs to read.
        if (this.visible && this.workstreams.some((ws) => ws.key === key)) void this.load([key]);
      }, FOLLOW_UP_MS),
    );
  }

  /** Reads every worktree's runs now. */
  refresh(): Promise<void> {
    return this.load();
  }

  /** Asks for the GitHub sign-in (a dialog, unlike the silent reads), then reads the runs. */
  async signIn(): Promise<void> {
    // A dismissed dialog is not an error: the view stays at "Sign in to GitHub".
    if (!this.api) await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then(undefined, () => undefined);
    await this.load();
  }

  /** A run was expanded or collapsed: its jobs are read now, and while it's expanded. */
  async expand(key: string, runId: number, expanded: boolean): Promise<void> {
    const runs = this.expanded.get(key) ?? new Set<number>();
    if (expanded) runs.add(runId);
    else {
      runs.delete(runId);
      this.jobs.get(key)?.delete(runId);
    }
    if (runs.size) this.expanded.set(key, runs);
    else this.expanded.delete(key);
    if (expanded) await this.load([key]);
    else this.post(this.snapshot());
  }

  /** Shows a job's log in an editor, of the repository the worktree's runs are on (the log's command checks the ids). */
  async showLog(key: string, jobId: number, jobName: string): Promise<void> {
    const view = this.views.get(key);
    if (view?.kind !== 'runs') return;
    const [owner, repo] = view.repo.split('/');
    await vscode.commands.executeCommand('flotilla.showJobLog', { owner, repo, jobId, jobName });
  }

  /** The views as last read, of the worktrees there are now (sent to a sidebar that has just loaded). */
  snapshot(): Record<string, CiView> {
    return Object.fromEntries(
      [...this.views]
        .filter(([key]) => this.workstreams.some((ws) => ws.key === key))
        .map(([key, view]): [string, CiView] => [key, view.kind === 'runs' ? { ...view, runs: view.runs.map((run) => this.withJobs(key, run)) } : view]),
    );
  }

  /** A run's jobs, for a run the user expanded (until they're read, the run shows it's loading). */
  private withJobs(key: string, run: CiRunView): CiRunView {
    const state = this.jobs.get(key)?.get(run.id);
    if (!this.expanded.get(key)?.has(run.id) || !state) return run;
    return { ...run, jobs: state.jobs, jobsError: state.error };
  }

  /** Reads the jobs of a worktree's expanded runs, the ones that are due (see jobsDue). A failed read is kept as the error. */
  private async readJobs(key: string, session: Session | undefined): Promise<void> {
    const view = this.views.get(key);
    const expanded = this.expanded.get(key);
    if (!session || !expanded || view?.kind !== 'runs') return;
    const [owner, repo] = view.repo.split('/');
    const actions = new GitHubActions(owner, repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch, this.api);
    const jobs = this.jobs.get(key) ?? new Map<number, JobsState>();
    this.jobs.set(key, jobs);
    await Promise.all(
      [...expanded].map(async (runId) => {
        const run = view.runs.find((r) => r.id === runId);
        const known = jobs.get(runId);
        if (!run || !jobsDue(run.status, known)) return;
        try {
          jobs.set(runId, { status: run.status, jobs: await actions.jobs(runId) });
        } catch (error) {
          jobs.set(runId, { status: run.status, error: message(error) });
        }
      }),
    );
  }

  private async load(keys?: string[]): Promise<void> {
    clearTimeout(this.timer);
    const targets = this.workstreams.filter((ws) => !keys || keys.includes(ws.key));
    const wheres = await Promise.all(targets.map(async (ws) => ({ ws, where: await this.where(ws) })));
    const github = wheres.some((w) => w.where.kind === 'github');
    // Without a sign-in (or a provider to ask), the runs say so: they're not read. The fake GitHub needs no sign-in.
    let session: Session | undefined;
    if (github && this.api) session = { accessToken: FAKE_TOKEN };
    else if (github) session = await vscode.authentication.getSession('github', SCOPES, { silent: true }).then((s) => s, () => undefined);
    // Worktrees on the same branch share one read.
    const reads = new Map<string, Promise<BranchRead>>();
    await Promise.all(
      wheres.map(async ({ ws, where }) => {
        const view = await this.viewOf(ws, where, session, reads);
        // A worktree removed while its runs were read has no view any more.
        if (this.workstreams.some((w) => w.key === ws.key)) this.views.set(ws.key, view);
      }),
    );
    this.post(this.snapshot());
    // The jobs of the expanded runs come after the runs, so that the runs show at once.
    await Promise.all(targets.map((ws) => this.readJobs(ws.key, session)));
    this.post(this.snapshot());
    // The last load to finish sets the next one (a load that overlapped another doesn't leave a second timer running).
    // Only the worktrees there are now count: a run or deployment on a removed one doesn't keep the timer short.
    const views = Object.values(this.snapshot());
    const anyActive =
      anyRunActive(views.flatMap((v) => (v.kind === 'runs' ? v.runs : []))) ||
      anyDeploymentActive(views.flatMap((v) => (v.kind === 'runs' ? v.deployments : [])));
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

  private async viewOf(ws: Workstream, where: Where, session: Session | undefined, reads: Map<string, Promise<BranchRead>>): Promise<CiView> {
    if (where.kind === 'view') return where.view;
    if (!session) return { kind: 'signIn' };
    const { owner, repo, branch } = where;
    const token = session.accessToken;
    const id = `${owner}/${repo}@${branch}`;
    try {
      let read = reads.get(id);
      if (!read) {
        read = readBranch(owner, repo, branch, async () => token, this.api);
        reads.set(id, read);
      }
      const { runs, deployments, deploymentsError } = await read;
      // The runs of the commit checked out here are marked.
      return {
        kind: 'runs',
        repo: `${owner}/${repo}`,
        branch,
        runs: runs.map((r) => ({ ...r, current: r.sha === ws.sync.head })),
        deployments,
        deploymentsError,
      };
    } catch (error) {
      return { kind: 'error', error: message(error) };
    }
  }
}
