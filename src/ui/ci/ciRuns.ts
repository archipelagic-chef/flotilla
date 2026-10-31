import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGit } from '../../core/git/gitCli';
import {
  gitHubName,
  gitHubRepo,
} from '../../features/backlog/sources/github';
import type { Fetch } from '../../features/backlog/sources/source';
import {
  type CiJob,
  type CiRun,
  type CiStatus,
  GitHubActions,
  isActive,
  splitUpstream,
} from '../../features/ci/githubActions';
import {
  type CiDeployment,
  GitHubDeployments,
} from '../../features/ci/githubDeployments';
import {
  anyDeploymentActive,
  anyRunActive,
  CI_ACTIVE_INTERVAL_MS,
  ciStamp,
  jobsDue,
  refreshDelay,
} from '../../features/ci/refresh';
import { failedJob } from '../../features/ci/failureTask';
import {
  finished,
  type FinishedRun,
} from '../../features/ci/notify';
import { fakeGitHubSession } from '../../features/ci/fakeSession';
import {
  type RunAction,
  runActions,
} from '../../features/ci/runActions';
import type { Workstream } from '../../features/workstreams/workstream';
import type {
  CiBusy,
  CiRunView,
  CiView,
  RunBusy,
} from '../../webview/protocol';

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

/** Who expanded a run: the sidebar's CI/CD view, or an open ticket (by its id). */
const SIDEBAR = 'sidebar';

/**
 * The CI/CD view's data: the latest workflow runs of each worktree's branch on GitHub, read through the user's GitHub
 * sign-in. Read at once when the sidebar shows and when a worktree's commit or upstream moves (a push), then every
 * minute while it's shown (every 10 seconds while a run goes on); nothing while it's hidden.
 *
 * Open tickets watch their worktrees (BL-106): those are read when the ticket opens and on a push, then every 10
 * seconds only while one of their runs is queued or running. Both get the same views and share the reads.
 */
export class CiRuns implements vscode.Disposable {
  private views = new Map<string, CiView>();
  private workstreams: readonly Workstream[] = [];
  private stamps = new Map<string, string>();
  /** The runs the user expanded, per worktree, and where (the sidebar, tickets): their jobs are read. */
  private expanded = new Map<string, Map<number, Set<string>>>();
  /** The worktrees each open ticket watches, by its id. */
  private watchers = new Map<string, string[]>();
  /** Who else gets the views (the open tickets). */
  private listeners = new Set<(views: Record<string, CiView>) => void>();
  private jobs = new Map<string, Map<number, JobsState>>();
  private visible = false;
  /** Whether it reads while the sidebar is hidden (this window leads and tells the user about finished runs). */
  private keepReading = false;
  /** The runs as last read, by worktree: a run that has finished since (and was going) is news. */
  private lastRuns = new Map<string, CiRunView[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** One read per worktree, a few seconds after its run was acted on (each action has its own). */
  private followUps = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * The runs' actions on their way, by worktree and run (a click on one already sent or asking is ignored): each run
   * shows its own as working (BL-119), from the click until GitHub answered and the runs were read again.
   */
  private acting = new Map<string, RunBusy>();
  /** Refreshes going on: every view shows it. */
  private refreshing = 0;
  /** What's being started on the worktrees: a Run Workflow… or a ticket's Run CI (BL-222), as "kind\nkey". */
  private starting = new Set<string>();

  /**
   * post sends the views of every worktree to the sidebar; api, when set, is the fake GitHub (no sign-in then).
   * onFinished gets the runs that finished since they were last read (while they were going).
   */
  constructor(
    private readonly post: (views: Record<string, CiView>) => void,
    private readonly api?: string,
    private readonly onFinished?: (items: FinishedRun[]) => void,
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
      this.lastRuns.delete(key);
    }
    const read = this.broad ? moved : moved.filter((ws) => this.watched.has(ws.key));
    if (read.length) void this.load(read.map((ws) => ws.key));
    else if (gone.length) this.publish();
  }

  /** Gets the views whenever they're sent (as the sidebar gets them). */
  onDidChange(listener: (views: Record<string, CiView>) => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * An open ticket (id) shows the CI of these worktrees: the ones it didn't watch yet are read now (unless the sidebar
   * keeps them read), and all of them while a run of theirs goes on. No keys: it stops watching (it's closed).
   */
  watch(id: string, keys: readonly string[]): void {
    const before = this.watched;
    if (keys.length) this.watchers.set(id, [...keys]);
    else this.watchers.delete(id);
    const fresh = keys.filter((key) => !before.has(key) && (!this.broad || !this.views.has(key)));
    if (fresh.length) void this.load(fresh);
    else this.schedule();
  }

  /** A ticket was closed: it watches nothing, and the runs it expanded are its own (the sidebar's stay expanded). */
  unwatch(id: string): void {
    for (const [key, runs] of [...this.expanded]) for (const runId of [...runs.keys()]) this.setExpanded(key, runId, id, false);
    this.watch(id, []);
  }

  /** The worktrees open tickets watch. */
  private get watched(): Set<string> {
    return new Set([...this.watchers.values()].flat());
  }

  /** Sends the views to the sidebar and the tickets. */
  private publish(): void {
    const views = this.snapshot();
    this.post(views);
    for (const listener of this.listeners) listener(views);
  }

  /** The sidebar is shown (reads now, then regularly) or hidden (nothing is read). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) void this.load();
    else if (!this.keepReading) this.schedule();
  }

  /** Whether it keeps reading while the sidebar is hidden (for the notices of the leading window). */
  setKeepReading(on: boolean): void {
    if (on === this.keepReading) return;
    this.keepReading = on;
    if (on && !this.visible) void this.load();
    else if (!on && !this.visible) this.schedule();
  }

  /** Every worktree's runs are read while the sidebar is shown, or while this window keeps reading for notices. */
  private get broad(): boolean {
    return this.visible || this.keepReading;
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
    this.acting.set(flight, action);
    this.publish();
    let asked = false;
    try {
      if (action === 'cancel') {
        const answer = await vscode.window.showWarningMessage(`Cancel ${run.workflow} #${run.number} on ${view.branch}?`, { modal: true }, 'Cancel run');
        if (answer !== 'Cancel run') return;
      }
      // A dismissed sign-in dialog ends it: nothing was asked of GitHub. The fake GitHub never gets a real token.
      const session: Session | undefined = this.api
        ? this.fakeSession(true)
        : await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then(
            (s) => s,
            () => undefined,
          );
      if (!session) return;
      const [owner, repo] = view.repo.split('/');
      const github = new GitHubActions(owner, repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch, this.api);
      asked = true;
      if (action === 'cancel') await github.cancel(runId);
      else await github.rerun(runId, action === 'rerunFailed');
    } finally {
      try {
        // Read the runs again even when GitHub refused: a refusal ("already finished") is when the view is most out of date.
        if (asked) {
          await this.load([key]);
          this.followUpRead(key);
        }
      } finally {
        this.acting.delete(flight);
        this.publish();
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
        // Nothing is read while the sidebar is hidden (unless a ticket shows it), and a removed worktree has no runs to read.
        if ((this.visible || this.watched.has(key)) && this.workstreams.some((ws) => ws.key === key)) void this.load([key]);
      }, FOLLOW_UP_MS),
    );
  }

  /** Reads every worktree's runs now; the views show it until they're read (quiet: they don't, for a read nobody clicked). */
  async refresh(quiet = false): Promise<void> {
    if (quiet) return this.load();
    this.refreshing += 1;
    this.publish();
    try {
      await this.load();
    } finally {
      this.refreshing -= 1;
      this.publish();
    }
  }

  /**
   * Run Workflow… on a worktree (start: its dialogs and GitHub's dispatch; true when a run was started): its view shows
   * it from the click until the dialogs are done and, when a run was started, the runs are read again. Another click
   * meanwhile does nothing. A ticket's Run CI (busy: runCi) goes the same way.
   */
  async runWorkflow(key: string, start: () => Promise<boolean>, busy: 'runWorkflow' | 'runCi' = 'runWorkflow'): Promise<boolean> {
    const flight = `${busy}\n${key}`;
    if (this.starting.has(flight)) return false;
    this.starting.add(flight);
    this.publish();
    try {
      const started = await start();
      if (started) await this.load();
      return started;
    } finally {
      this.starting.delete(flight);
      this.publish();
    }
  }

  /** Asks for the GitHub sign-in (a dialog, unlike the silent reads), then reads the runs. */
  async signIn(): Promise<void> {
    // A dismissed dialog is not an error: the view stays at "Sign in to GitHub".
    if (this.api) fakeGitHubSession.signIn();
    else await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then(undefined, () => undefined);
    await this.load();
  }

  /** The fake GitHub's session: none while it's signed out (BL-245), unless asked for as the sign-in dialog would. */
  private fakeSession(create: boolean): Session | undefined {
    if (create) fakeGitHubSession.signIn();
    return fakeGitHubSession.signedIn ? { accessToken: FAKE_TOKEN } : undefined;
  }

  /**
   * A run was expanded or collapsed, in the sidebar or in a ticket (by): its jobs are read now, and while it's expanded
   * anywhere.
   */
  async expand(key: string, runId: number, expanded: boolean, by = SIDEBAR): Promise<void> {
    this.setExpanded(key, runId, by, expanded);
    if (expanded) await this.load([key]);
    else this.publish();
  }

  /** Marks a run expanded (or not) by one of the views; its jobs are forgotten once no view has it expanded. */
  private setExpanded(key: string, runId: number, by: string, expanded: boolean): void {
    const runs = this.expanded.get(key) ?? new Map<number, Set<string>>();
    const views = runs.get(runId) ?? new Set<string>();
    if (expanded) views.add(by);
    else views.delete(by);
    if (views.size) runs.set(runId, views);
    else {
      runs.delete(runId);
      this.jobs.get(key)?.delete(runId);
    }
    if (runs.size) this.expanded.set(key, runs);
    else this.expanded.delete(key);
  }

  /**
   * Fix with Agent on a failed job of a run the view shows (BL-7's command, with the job's failed steps and log). No
   * job: the run's first failed job.
   */
  async fix(key: string, runId: number, jobId?: number): Promise<void> {
    const view = this.views.get(key);
    const run = view?.kind === 'runs' ? view.runs.find((r) => r.id === runId) : undefined;
    if (view?.kind !== 'runs' || !run) throw new Error("That run isn't in this worktree's CI any more. Refresh it and try again.");
    // The run shows it's working from the click until the agent's chat opened (or nothing was started).
    const flight = `${key}\n${runId}`;
    if (this.acting.has(flight)) return;
    this.acting.set(flight, 'fix');
    this.publish();
    try {
      await this.startFix(view, run, jobId);
    } finally {
      this.acting.delete(flight);
      this.publish();
    }
  }

  private async startFix(view: Extract<CiView, { kind: 'runs' }>, run: CiRunView, jobId?: number): Promise<void> {
    const session: Session | undefined = this.api
      ? this.fakeSession(true)
      : await vscode.authentication.getSession('github', SCOPES, { createIfNone: true }).then(
          (s) => s,
          () => undefined,
        );
    if (!session) return;
    const [owner, repo] = view.repo.split('/');
    const github = new GitHubActions(owner, repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch, this.api);
    const failure = await failedJob(github, view.branch, run, jobId);
    if (!failure) {
      void vscode.window.showWarningMessage(`No job of ${run.workflow} #${run.number} failed, so there's nothing for an agent to fix.`);
      return;
    }
    await vscode.commands.executeCommand('flotilla.ci.fixWithAgent', failure);
  }

  /**
   * GitHub's runs of the repository's origin, for Merge to main to decide on (BL-105), or why they can't be read: no
   * GitHub origin, or no GitHub sign-in (never asked for here: without one, the checks run locally). interactive: asks
   * to sign in (for an action the user clicked).
   */
  async originActions(cwd: string, interactive = false): Promise<GitHubActions | string> {
    const url = (await runGit(['remote', 'get-url', 'origin'], { cwd }).catch(() => '')).trim();
    if (!url) return 'the repository has no `origin`.';
    const gh = gitHubRepo(url);
    if (!gh || !gitHubName(gh.owner) || !gitHubName(gh.repo)) return "`origin` isn't a GitHub repository.";
    const session: Session | undefined = this.api
      ? this.fakeSession(interactive)
      : await vscode.authentication.getSession('github', SCOPES, interactive ? { createIfNone: true } : { silent: true }).then(
          (s) => s,
          () => undefined,
        );
    if (!session) return "you aren't signed in to GitHub in VS Code (the CI/CD view's Sign In).";
    return new GitHubActions(gh.owner, gh.repo, async () => session.accessToken, globalThis.fetch as unknown as Fetch, this.api);
  }

  /**
   * Fix with Agent on a failed job of a branch's run on origin (BL-7), from Merge to main's red CI. runBranch: the ref
   * the run is on, when it isn't the branch the agent fixes (the ticket's train branch, BL-145).
   */
  async fixOnOrigin(cwd: string, branch: string, runId: number, jobId?: number, runBranch = branch): Promise<void> {
    const github = await this.originActions(cwd, true);
    if (typeof github === 'string') throw new Error(`Can't read the run: ${github}`);
    const run = (await github.runs(runBranch, 30)).find((r) => r.id === runId);
    const failure = run && (await failedJob(github, branch, run, jobId));
    if (!failure) {
      void vscode.window.showWarningMessage("That run has no failed job any more, so there's nothing for an agent to fix.");
      return;
    }
    await vscode.commands.executeCommand('flotilla.ci.fixWithAgent', failure);
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
        .map(([key, view]): [string, CiView] => {
          const shown: CiView = view.kind === 'runs' ? { ...view, runs: view.runs.map((run) => this.withBusy(key, this.withJobs(key, run))) } : view;
          const starting = (['runWorkflow', 'runCi'] as const).filter((kind) => this.starting.has(`${kind}\n${key}`));
          const busy: CiBusy[] = [...(this.refreshing ? (['refresh'] as const) : []), ...starting];
          return [key, busy.length ? { ...shown, busy } : shown];
        }),
    );
  }

  /** A run with the action on its way (if one is). */
  private withBusy(key: string, run: CiRunView): CiRunView {
    const busy = this.acting.get(`${key}\n${run.id}`);
    return busy ? { ...run, busy } : run;
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
      [...expanded.keys()].map(async (runId) => {
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

  /** The runs that finished since the last read, of the worktrees there are now. */
  private reportFinished(): void {
    const items: FinishedRun[] = [];
    for (const ws of this.workstreams) {
      const view = this.views.get(ws.key);
      if (view?.kind !== 'runs') continue;
      for (const run of finished(this.lastRuns.get(ws.key) ?? [], view.runs)) items.push({ key: ws.key, repo: view.repo, branch: view.branch, run });
      this.lastRuns.set(ws.key, view.runs);
    }
    if (items.length) this.onFinished?.(items);
  }

  private async load(keys?: string[]): Promise<void> {
    clearTimeout(this.timer);
    const targets = this.workstreams.filter((ws) => !keys || keys.includes(ws.key));
    const wheres = await Promise.all(targets.map(async (ws) => ({ ws, where: await this.where(ws) })));
    const github = wheres.some((w) => w.where.kind === 'github');
    // Without a sign-in (or a provider to ask), the runs say so: they're not read. The fake GitHub's is fakeSession's.
    let session: Session | undefined;
    if (github && this.api) session = this.fakeSession(false);
    else if (github)
      session = await vscode.authentication.getSession('github', SCOPES, { silent: true }).then(
        (s) => s,
        () => undefined,
      );
    // Worktrees on the same branch share one read.
    const reads = new Map<string, Promise<BranchRead>>();
    await Promise.all(
      wheres.map(async ({ ws, where }) => {
        const view = await this.viewOf(ws, where, session, reads);
        // A worktree removed while its runs were read has no view any more.
        if (this.workstreams.some((w) => w.key === ws.key)) this.views.set(ws.key, view);
      }),
    );
    this.reportFinished();
    this.publish();
    // The jobs of the expanded runs come after the runs, so that the runs show at once.
    await Promise.all(targets.map((ws) => this.readJobs(ws.key, session)));
    this.publish();
    // The last load to finish sets the next one (a load that overlapped another doesn't leave a second timer running).
    this.schedule();
  }

  /**
   * Sets the next read: of every worktree while the sidebar reads them (see refreshDelay), else of the worktrees
   * tickets watch, only while a run or deployment of theirs goes on. Only the worktrees there are now count: a run or
   * deployment on a removed one doesn't keep the timer short.
   */
  private schedule(): void {
    clearTimeout(this.timer);
    const watched = this.watched;
    const views = Object.entries(this.snapshot())
      .filter(([key]) => this.broad || watched.has(key))
      .map(([, view]) => view);
    const anyActive =
      anyRunActive(views.flatMap((v) => (v.kind === 'runs' ? v.runs : []))) ||
      anyDeploymentActive(views.flatMap((v) => (v.kind === 'runs' ? v.deployments : [])));
    if (this.broad) {
      const delay = refreshDelay(true, anyActive);
      this.timer = delay === undefined ? undefined : setTimeout(() => void this.load(), delay);
    } else {
      this.timer = watched.size && anyActive ? setTimeout(() => void this.load([...watched]), CI_ACTIVE_INTERVAL_MS) : undefined;
    }
  }

  /** Where a worktree's runs are: its branch on GitHub, or the view that says why there are none. */
  private async where(ws: Workstream): Promise<Where> {
    const cwd = ws.worktree.path;
    // Every worktree gets a view, so the All tab never waits on one that can't be read.
    if (!cwd) return { kind: 'view', view: { kind: 'error', error: "This worktree's folder isn't reachable from this environment." } };
    const upstream = ws.sync.upstream;
    if (!upstream) return { kind: 'view', view: { kind: 'unpublished', ...(await pushable(cwd)) } };
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

/**
 * Of a branch not pushed yet: origin's GitHub repository, when it is one and the worktree has workflows, so a push would
 * start them (a ticket's Run CI, BL-222). Nothing otherwise.
 */
async function pushable(cwd: string): Promise<{ repo?: string }> {
  // Read at once (a folder of a few files): a branch without workflows answers in the same turn as before.
  let workflows: string[] = [];
  try {
    workflows = fs.readdirSync(path.join(cwd, '.github', 'workflows'));
  } catch {
    return {};
  }
  if (!workflows.some((f) => /\.ya?ml$/.test(f))) return {};
  const gh = gitHubRepo((await runGit(['remote', 'get-url', 'origin'], { cwd }).catch(() => '')).trim());
  return gh && gitHubName(gh.owner) && gitHubName(gh.repo) ? { repo: `${gh.owner}/${gh.repo}` } : {};
}
