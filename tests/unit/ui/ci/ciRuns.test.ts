import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CiRuns } from '../../../../src/ui/ci/ciRuns';
import type { Workstream } from '../../../../src/features/workstreams/workstream';
import type { CiView } from '../../../../src/webview/protocol';

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
const git = vi.hoisted(() => ({ runGit: vi.fn() }));
const commands = vi.hoisted(() => ({ executeCommand: vi.fn() }));
const win = vi.hoisted(() => ({ showWarningMessage: vi.fn() }));

vi.mock('vscode', () => ({ authentication: auth, commands, window: win }));
vi.mock('../../../../src/core/git/gitCli', () => git);

const GITHUB = 'git@github.com:acme/app.git';
const session = { accessToken: 'token' };

interface ApiRun {
  id: number;
  name: string;
  run_number: number;
  display_title: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  created_at: string;
}

const apiRun = (over: Partial<ApiRun> = {}): ApiRun => ({
  id: 1,
  name: 'CI',
  run_number: 7,
  display_title: 'Fix the build',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/app/actions/runs/1',
  head_sha: 'abc',
  created_at: '2026-10-11T10:00:00Z',
  ...over,
});

/** A worktree as the sidebar builds it: reachable at /work/<key> unless said otherwise. */
function ws(key: string, over: { path?: string | undefined; upstream?: string; head?: string } = {}): Workstream {
  return {
    key,
    worktree: { path: 'path' in over ? over.path : `/work/${key}` },
    sync: { upstream: 'upstream' in over ? over.upstream : 'origin/feat', ahead: 0, behind: 0, hasRemote: true, head: over.head ?? 'abc' },
  } as unknown as Workstream;
}

/** Git answers with these remotes: name → URL. */
function remotes(urls: Record<string, string> = { origin: GITHUB }) {
  git.runGit.mockImplementation(async (args: string[]) => {
    if (args.length === 1 && args[0] === 'remote') return Object.keys(urls).join('\n');
    if (args[0] === 'remote' && args[1] === 'get-url') return `${urls[args[2]]}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
}

/**
 * GitHub answers with each branch's runs (runs.feat, …); the object can change between reads. options.status makes it
 * refuse; options.hold makes it wait until release() (a read still in flight).
 */
function github(
  runs: Record<string, ApiRun[]> = { feat: [apiRun()] },
  options: { status?: number; hold?: boolean; deployments?: Record<string, unknown[]>; deploymentsStatus?: number } = {},
) {
  let release!: () => void;
  const gate = options.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    await gate;
    const u = new URL(url);
    // Deployments: a branch's list (deployments.feat), and each deployment's statuses (deployments.statuses-<id>).
    const deploymentRoute = u.pathname.includes('/deployments');
    const status = deploymentRoute ? (options.deploymentsStatus ?? options.status) : options.status;
    const ok = status === undefined;
    const payload = deploymentRoute
      ? (options.deployments?.[u.pathname.endsWith('/statuses') ? `statuses-${u.pathname.split('/')[5]}` : (u.searchParams.get('ref') ?? '')] ?? [])
      : { workflow_runs: runs[u.searchParams.get('branch') ?? ''] ?? [] };
    const body = JSON.stringify(payload);
    return {
      ok,
      status: status ?? 200,
      statusText: ok ? 'OK' : 'Server Error',
      json: async () => JSON.parse(body),
      text: async () => (ok ? body : 'boom'),
    };
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, runs, release: () => release() };
}

/**
 * Sign-in: silent reads get the session once the user is signed in; the dialog (createIfNone) signs them in unless it's
 * dismissed.
 */
function signedIn({ start = true, dialog = true }: { start?: boolean; dialog?: boolean } = {}) {
  let isSignedIn = start;
  auth.getSession.mockImplementation(async (_provider: string, _scopes: string[], options?: { silent?: boolean; createIfNone?: boolean }) => {
    if (options?.createIfNone) {
      if (!dialog) throw new Error('Canceled');
      isSignedIn = true;
      return session;
    }
    return isSignedIn ? session : undefined;
  });
}

function setup() {
  const post = vi.fn();
  const ci = new CiRuns(post);
  const last = () => post.mock.lastCall?.[0] as Record<string, CiView>;
  return { ci, post, last };
}

/** How many reads of the runs GitHub got (a read of a branch is also a read of its deployments). */
const runReads = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.filter(([url]) => String(url).includes('/actions/runs')).length;

/** Lets the reads that are waiting on each other finish (a read takes several awaits). */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  remotes();
  signedIn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CiRuns: what each worktree shows', () => {
  it('shows the runs of its branch, marking the one checked out here', async () => {
    const { fetch } = github({ feat: [apiRun({ id: 1, head_sha: 'abc' }), apiRun({ id: 2, head_sha: 'def', run_number: 8 })] });
    const { ci, last } = setup();
    ci.update([ws('a', { head: 'def' })]);
    ci.setVisible(true);
    await settle();

    expect(fetch.mock.calls[0][0]).toContain('/repos/acme/app/actions/runs?branch=feat&');
    const view = last().a;
    expect(view.kind).toBe('runs');
    if (view.kind !== 'runs') return;
    expect(view.repo).toBe('acme/app');
    expect(view.branch).toBe('feat');
    expect(view.runs.map((r) => [r.number, r.current])).toEqual([
      [7, false],
      [8, true],
    ]);
    ci.dispose();
  });

  it('asks the user to sign in, and reads nothing, when there is no GitHub sign-in', async () => {
    signedIn({ start: false });
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'signIn' });
    expect(fetch).not.toHaveBeenCalled();
    ci.dispose();
  });

  it('stays at "Sign in" when the sign-in dialog is dismissed, without an error', async () => {
    signedIn({ start: false, dialog: false });
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a')]);
    await ci.signIn();

    expect(last().a).toEqual({ kind: 'signIn' });
    expect(fetch).not.toHaveBeenCalled();
    ci.dispose();
  });

  it('reads the runs once the user signs in through the dialog', async () => {
    signedIn({ start: false, dialog: true });
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a')]);
    await ci.signIn();

    expect(auth.getSession).toHaveBeenCalledWith('github', ['repo'], { createIfNone: true });
    expect(runReads(fetch)).toBe(1);
    expect(last().a.kind).toBe('runs');
    ci.dispose();
  });

  it('says a worktree with no upstream is unpublished, and runs no git or GitHub read for it', async () => {
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a', { upstream: undefined })]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'unpublished' });
    expect(git.runGit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    ci.dispose();
  });

  it('says the branch is not on GitHub when its remote is another host', async () => {
    remotes({ origin: 'git@gitlab.com:acme/app.git' });
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
    ci.dispose();
  });

  it('says the upstream is not on a remote of this repository', async () => {
    remotes({ origin: GITHUB });
    const { ci, last } = setup();
    ci.update([ws('a', { upstream: 'upstream/feat' })]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'error', error: 'The upstream upstream/feat is not on a remote of this repository.' });
    ci.dispose();
  });

  it('shows the error when GitHub refuses the read', async () => {
    github({}, { status: 500 });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'error', error: '500 Server Error: boom' });
    ci.dispose();
  });

  it('shows the error when git cannot read the remote', async () => {
    git.runGit.mockRejectedValue(new Error('not a git repository'));
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'error', error: 'not a git repository' });
    ci.dispose();
  });

  it('answers at once for a worktree whose folder is not reachable here, so the All tab does not wait', async () => {
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a', { path: undefined })]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'error', error: "This worktree's folder isn't reachable from this environment." });
    expect(fetch).not.toHaveBeenCalled();
    ci.dispose();
  });

  it('reads a branch once for the worktrees that share it', async () => {
    const { fetch } = github();
    const { ci, last } = setup();
    ci.update([ws('a'), ws('b')]);
    ci.setVisible(true);
    await settle();

    expect(runReads(fetch)).toBe(1);
    expect(last().a.kind).toBe('runs');
    expect(last().b.kind).toBe('runs');
    ci.dispose();
  });

  it('drops the view of a worktree removed while its runs were read', async () => {
    const reads = github({ feat: [apiRun()] }, { hold: true });
    const { ci, last } = setup();
    ci.update([ws('a'), ws('b', { upstream: undefined })]);
    ci.setVisible(true);
    await settle();

    ci.update([ws('b', { upstream: undefined })]);
    reads.release();
    await settle();

    expect(Object.keys(last())).toEqual(['b']);
    ci.dispose();
  });

  it('does not let a read that finished after its removal show again when the worktree comes back', async () => {
    const reads = github({ feat: [apiRun()] }, { hold: true });
    const { ci } = setup();
    ci.update([ws('a'), ws('b', { upstream: undefined })]);
    ci.setVisible(true);
    await settle();

    ci.update([ws('b', { upstream: undefined })]);
    reads.release();
    await settle();
    ci.update([ws('a'), ws('b', { upstream: undefined })]);

    expect(Object.keys(ci.snapshot())).toEqual(['b']);
    ci.dispose();
  });

  it('forgets a removed worktree at once, and posts the rest', async () => {
    const { ci, last, post } = setup();
    ci.update([ws('a', { upstream: undefined }), ws('b', { upstream: undefined })]);
    ci.setVisible(true);
    await settle();
    post.mockClear();

    ci.update([ws('b', { upstream: undefined })]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(Object.keys(last())).toEqual(['b']);
    ci.dispose();
  });
});

describe('CiRuns: when it reads', () => {
  it('reads nothing while the sidebar is hidden, not on a timer and not when a push moves a worktree', async () => {
    const { fetch } = github();
    const { ci, post } = setup();
    ci.update([ws('a')]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    ci.update([ws('a', { head: 'new' })]);
    await settle();

    expect(fetch).not.toHaveBeenCalled();
    expect(git.runGit).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    ci.dispose();
  });

  it('schedules no read while hidden, even one made by a manual refresh', async () => {
    const { fetch } = github();
    const { ci } = setup();
    ci.update([ws('a')]);
    await ci.refresh();
    expect(runReads(fetch)).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runReads(fetch)).toBe(1);
    ci.dispose();
  });

  it('reads at once when shown, then every minute', async () => {
    const { fetch } = github();
    const { ci } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    expect(runReads(fetch)).toBe(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(runReads(fetch)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runReads(fetch)).toBe(2);
    ci.dispose();
  });

  it('reads every 10 seconds while a run is queued or running, then every minute once it has finished', async () => {
    const reads = github({ feat: [apiRun({ status: 'in_progress', conclusion: null })] });
    const { ci } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    expect(runReads(reads.fetch)).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReads(reads.fetch)).toBe(2);

    // The run finishes: the read 10 seconds on sees it, and the one after waits a minute.
    reads.runs.feat = [apiRun()];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReads(reads.fetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runReads(reads.fetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(runReads(reads.fetch)).toBe(4);
    ci.dispose();
  });

  it('reads every 10 seconds while a deployment is in progress, then every minute once it has finished', async () => {
    // A branch with no runs yet, only a deployment going on.
    const deployments: Record<string, unknown[]> = {
      feat: [{ id: 11, sha: 'abc1234def', environment: 'staging', created_at: new Date().toISOString() }],
      'statuses-11': [{ state: 'in_progress' }],
    };
    const reads = github({ feat: [] }, { deployments });
    const { ci } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    expect(runReads(reads.fetch)).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReads(reads.fetch)).toBe(2);

    // The deployment finishes: the read 10 seconds on sees it, and the one after waits a minute.
    deployments['statuses-11'] = [{ state: 'success' }];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReads(reads.fetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runReads(reads.fetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(runReads(reads.fetch)).toBe(4);
    ci.dispose();
  });

  it('reads every minute, not every 10 seconds, for a deployment that has been in progress for hours', async () => {
    const deployments: Record<string, unknown[]> = {
      feat: [{ id: 11, sha: 'abc1234def', environment: 'staging', created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }],
      'statuses-11': [{ state: 'in_progress' }],
    };
    const reads = github({ feat: [] }, { deployments });
    const { ci } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    expect(runReads(reads.fetch)).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReads(reads.fetch)).toBe(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(runReads(reads.fetch)).toBe(2);
    ci.dispose();
  });

  it('reads a worktree again at once when its commit moves (a push)', async () => {
    const { fetch } = github();
    const { ci } = setup();
    ci.update([ws('a', { head: 'abc' }), ws('b', { head: 'abc', upstream: undefined })]);
    ci.setVisible(true);
    await settle();
    expect(runReads(fetch)).toBe(1);

    ci.update([ws('a', { head: 'def' }), ws('b', { head: 'abc', upstream: undefined })]);
    await settle();

    expect(runReads(fetch)).toBe(2);
    ci.dispose();
  });

  it('stops reading when hidden, even with a read due', async () => {
    const { fetch } = github();
    const { ci } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    ci.setVisible(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runReads(fetch)).toBe(1);
    ci.dispose();
  });

  it('does not keep the 10-second timer for a run on a worktree that was removed', async () => {
    const reads = github({ active: [apiRun({ status: 'in_progress', conclusion: null })], done: [apiRun()] });
    const { ci } = setup();
    ci.update([ws('a', { upstream: 'origin/active' }), ws('b', { upstream: 'origin/done' })]);
    ci.setVisible(true);
    await settle();
    expect(runReads(reads.fetch)).toBe(2);

    // a goes; the 10-second read due next reads only b, which has no run in progress, so the one after waits a minute.
    ci.update([ws('b', { upstream: 'origin/done' })]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runReads(reads.fetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runReads(reads.fetch)).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(runReads(reads.fetch)).toBe(4);
    ci.dispose();
  });
});

describe('CiRuns: deployments', () => {
  const deployment = { id: 11, sha: 'abc1234def', environment: 'staging', created_at: '2026-10-10T10:00:00Z' };

  it('shows the latest deployment of each environment of the branch, with its state and site', async () => {
    github(
      { feat: [apiRun()] },
      { deployments: { feat: [deployment], 'statuses-11': [{ state: 'success', environment_url: 'https://staging.acme.test/' }] } },
    );
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    const view = last().a;
    expect(view.kind).toBe('runs');
    if (view.kind !== 'runs') return;
    expect(view.deployments).toEqual([expect.objectContaining({ environment: 'staging', state: 'success', sha: 'abc1234def', siteUrl: 'https://staging.acme.test/' })]);
    expect(view.deploymentsError).toBeUndefined();
    ci.dispose();
  });

  it('has no deployments when the branch was never deployed', async () => {
    github({ feat: [apiRun()] }, { deployments: { feat: [] } });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    const view = last().a;
    expect(view.kind === 'runs' && view.deployments).toEqual([]);
    ci.dispose();
  });

  it('keeps the runs when only the deployments fail, and says why there are no deployments', async () => {
    github({ feat: [apiRun()] }, { deploymentsStatus: 403 });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    const view = last().a;
    expect(view.kind).toBe('runs');
    if (view.kind !== 'runs') return;
    expect(view.runs.map((r) => r.number)).toEqual([7]);
    expect(view.deployments).toEqual([]);
    expect(view.deploymentsError).toBe('403 Server Error: boom');
    ci.dispose();
  });

  it('shows the runs\' error, and no deployments, when the runs cannot be read', async () => {
    github({ feat: [apiRun()] }, { status: 500 });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    expect(last().a).toEqual({ kind: 'error', error: '500 Server Error: boom' });
    ci.dispose();
  });
});

/** A run's job as GitHub answers it. */
const apiJob = (over: Record<string, unknown> = {}) => ({
  id: 9,
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/acme/app/actions/runs/1/job/9',
  steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: 'success' }],
  ...over,
});

/**
 * GitHub answers with each branch's runs, and with the jobs of each run (jobs.<run id>). A run's jobs
 * are read on their own URL, so these reads are counted apart from the runs' reads.
 */
function githubJobs(runs: Record<string, ApiRun[]>, jobs: Record<number, unknown[]>, options: { jobsStatus?: number } = {}) {
  const fetch = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/jobs')) {
      const runId = Number(/runs\/(\d+)\/jobs/.exec(parsed.pathname)![1]);
      const ok = options.jobsStatus === undefined;
      const body = JSON.stringify({ jobs: jobs[runId] ?? [] });
      return { ok, status: options.jobsStatus ?? 200, statusText: ok ? 'OK' : 'Server Error', json: async () => JSON.parse(body), text: async () => (ok ? body : 'boom') };
    }
    const body = JSON.stringify({ workflow_runs: runs[parsed.searchParams.get('branch') ?? ''] ?? [] });
    return { ok: true, status: 200, statusText: 'OK', json: async () => JSON.parse(body), text: async () => body };
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, jobReads: () => fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/jobs')).length };
}

const runsOf = (view: CiView | undefined) => (view?.kind === 'runs' ? view.runs : []);

describe('CiRuns: a run’s jobs', () => {
  it('reads no jobs until the user expands a run, then shows its jobs with their steps', async () => {
    const reads = githubJobs({ feat: [apiRun({ id: 1 })] }, { 1: [apiJob({ id: 9, conclusion: 'failure', steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: 'failure' }] })] });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    expect(reads.jobReads()).toBe(0);
    expect(runsOf(last().a)[0].jobs).toBeUndefined();

    await ci.expand('a', 1, true);
    const [run] = runsOf(last().a);
    expect(reads.jobReads()).toBe(1);
    expect(run.jobs).toEqual([
      { id: 9, name: 'test', status: 'failure', url: 'https://github.com/acme/app/actions/runs/1/job/9', steps: [{ number: 1, name: 'Run tests', status: 'failure' }] },
    ]);
    ci.dispose();
  });

  it('forgets a collapsed run’s jobs', async () => {
    githubJobs({ feat: [apiRun({ id: 1 })] }, { 1: [apiJob()] });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    await ci.expand('a', 1, true);
    expect(runsOf(last().a)[0].jobs).toHaveLength(1);

    await ci.expand('a', 1, false);
    expect(runsOf(last().a)[0].jobs).toBeUndefined();
    ci.dispose();
  });

  it('shows why the jobs can’t be read, and keeps the runs', async () => {
    githubJobs({ feat: [apiRun({ id: 1 })] }, {}, { jobsStatus: 500 });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    await ci.expand('a', 1, true);
    const [run] = runsOf(last().a);
    expect(run.jobsError).toBe('500 Server Error: boom');
    expect(run.jobs).toBeUndefined();
    expect(runsOf(last().a)).toHaveLength(1);
    ci.dispose();
  });

  it('reads an expanded run’s jobs again while it runs, and once more when it has finished', async () => {
    const reads = githubJobs({ feat: [apiRun({ id: 1, status: 'in_progress', conclusion: null })] }, { 1: [apiJob({ status: 'in_progress', conclusion: null })] });
    const { ci, last } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    await ci.expand('a', 1, true);
    expect(reads.jobReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads.jobReads()).toBe(2);
    expect(runsOf(last().a)[0].jobs?.[0].status).toBe('running');
    ci.dispose();
  });

  it('opens a job’s log for the worktree’s repository, through the log command', async () => {
    githubJobs({ feat: [apiRun({ id: 1 })] }, { 1: [apiJob()] });
    const { ci } = setup();
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();
    await ci.showLog('a', 9, 'test');
    expect(commands.executeCommand).toHaveBeenCalledWith('flotilla.showJobLog', { owner: 'acme', repo: 'app', jobId: 9, jobName: 'test' });
    ci.dispose();
  });

  it('opens no log for a worktree that has no runs', async () => {
    const { ci } = setup();
    ci.update([ws('a', { upstream: undefined })]);
    await ci.showLog('a', 9, 'test');
    expect(commands.executeCommand).not.toHaveBeenCalled();
    ci.dispose();
  });
});

describe('CiRuns: a run\'s actions', () => {
  /** Reads the worktree 'a' once (on feat), with the given runs, and returns the fake GitHub. */
  async function viewed(runs: ApiRun[]) {
    const reads = github({ feat: runs });
    const controller = setup();
    controller.ci.update([ws('a')]);
    controller.ci.setVisible(true);
    await settle();
    return { ...controller, reads };
  }

  const posts = (fetch: ReturnType<typeof github>['fetch']) =>
    (fetch.mock.calls as unknown as Array<[string, { method?: string; headers: Record<string, string> }]>).filter(([, init]) => init?.method === 'POST');

  it('re-runs a finished run, with the token, and reads the runs again', async () => {
    const { ci, reads } = await viewed([apiRun({ id: 1 })]);
    await ci.act('a', 1, 'rerun');
    expect(posts(reads.fetch).map(([url, init]) => [url, init.headers.Authorization])).toEqual([
      ['https://api.github.com/repos/acme/app/actions/runs/1/rerun', 'Bearer token'],
    ]);
    expect(reads.fetch.mock.calls.length).toBeGreaterThan(1);
    ci.dispose();
  });

  it('re-runs only the failed jobs when asked', async () => {
    const { ci, reads } = await viewed([apiRun({ id: 2, conclusion: 'failure' })]);
    await ci.act('a', 2, 'rerunFailed');
    expect(posts(reads.fetch).map(([url]) => url)).toEqual(['https://api.github.com/repos/acme/app/actions/runs/2/rerun-failed-jobs']);
    ci.dispose();
  });

  it('cancels a running run only after the user confirms', async () => {
    const { ci, reads } = await viewed([apiRun({ id: 3, status: 'in_progress', conclusion: null })]);
    win.showWarningMessage.mockResolvedValueOnce(undefined);
    await ci.act('a', 3, 'cancel');
    expect(win.showWarningMessage).toHaveBeenCalledWith('Cancel CI #7 on feat?', { modal: true }, 'Cancel run');
    expect(posts(reads.fetch)).toHaveLength(0);

    win.showWarningMessage.mockResolvedValueOnce('Cancel run');
    await ci.act('a', 3, 'cancel');
    expect(posts(reads.fetch).map(([url]) => url)).toEqual(['https://api.github.com/repos/acme/app/actions/runs/3/cancel']);
    ci.dispose();
  });

  it('does nothing when the sign-in dialog is dismissed', async () => {
    const { ci, reads } = await viewed([apiRun({ id: 1 })]);
    auth.getSession.mockRejectedValueOnce(new Error('Canceled'));
    await ci.act('a', 1, 'rerun');
    expect(posts(reads.fetch)).toHaveLength(0);
    ci.dispose();
  });

  it('refuses a run the view does not show, or an action the run is not offered', async () => {
    const { ci, reads } = await viewed([apiRun({ id: 1 })]);
    await expect(ci.act('a', 99, 'rerun')).rejects.toThrow("isn't in this worktree's CI/CD view any more");
    await expect(ci.act('b', 1, 'rerun')).rejects.toThrow("isn't in this worktree's CI/CD view any more");
    await expect(ci.act('a', 1, 'cancel')).rejects.toThrow("can't be cancelled now");
    await expect(ci.act('a', 1, 'rerunFailed')).rejects.toThrow("can't be re-run this way now");
    expect(posts(reads.fetch)).toHaveLength(0);
    ci.dispose();
  });

  it('shows what GitHub refused, as a message to act on', async () => {
    const { ci } = await viewed([apiRun({ id: 1 })]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}), text: async () => 'Resource not accessible by integration' })));
    await expect(ci.act('a', 1, 'rerun')).rejects.toThrow(/write access to the repository/);
    ci.dispose();
  });
});

describe('CiRuns: the reads after an action', () => {
  /** Worktree a is on branch feat, b on branch other; each has one run. */
  async function viewed() {
    const reads = github({ feat: [apiRun({ id: 1 })], other: [apiRun({ id: 2 })] });
    const controller = setup();
    controller.ci.update([ws('a', { upstream: 'origin/feat' }), ws('b', { upstream: 'origin/other' })]);
    controller.ci.setVisible(true);
    await settle();
    return { ...controller, reads };
  }

  /** How many reads (GET) have been made of a branch's runs. */
  const readsOf = (fetch: ReturnType<typeof github>['fetch'], branch: string) =>
    (fetch.mock.calls as unknown as Array<[string, { method?: string }?]>).filter(([url, init]) => init?.method !== 'POST' && new URL(url).searchParams.get('branch') === branch).length;

  it('reads a worktree 3 seconds after its action, and a second action in that time still gets its own read', async () => {
    const { ci, reads } = await viewed();
    await ci.act('a', 1, 'rerun');
    const feat = readsOf(reads.fetch, 'feat');

    await vi.advanceTimersByTimeAsync(2_000);
    await ci.act('b', 2, 'rerun');
    const other = readsOf(reads.fetch, 'other');

    await vi.advanceTimersByTimeAsync(999);
    expect(readsOf(reads.fetch, 'feat')).toBe(feat);
    await vi.advanceTimersByTimeAsync(1);
    expect(readsOf(reads.fetch, 'feat')).toBe(feat + 1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(readsOf(reads.fetch, 'other')).toBe(other + 1);
    ci.dispose();
  });

  it('does not read in the follow-up while the sidebar is hidden', async () => {
    const { ci, reads } = await viewed();
    await ci.act('a', 1, 'rerun');
    const feat = readsOf(reads.fetch, 'feat');
    ci.setVisible(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(readsOf(reads.fetch, 'feat')).toBe(feat);
    ci.dispose();
  });

  it('ignores a second click on an action that is already asking or on its way', async () => {
    const reads = github({ feat: [apiRun({ id: 3, status: 'in_progress', conclusion: null })] });
    const ci = setup().ci;
    ci.update([ws('a', { upstream: 'origin/feat' })]);
    ci.setVisible(true);
    await settle();
    let answer!: (value: string | undefined) => void;
    win.showWarningMessage.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = ci.act('a', 3, 'cancel').catch(() => undefined);
    await ci.act('a', 3, 'cancel');
    expect(win.showWarningMessage).toHaveBeenCalledTimes(1);
    answer('Cancel run');
    await first;
    const posts = (reads.fetch.mock.calls as unknown as Array<[string, { method?: string }?]>).filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    ci.dispose();
  });

  it('reads the runs again when GitHub refuses the action, and says why', async () => {
    const { ci } = await viewed();
    const body = JSON.stringify({ workflow_runs: [apiRun({ id: 1, status: 'completed', conclusion: 'success' })] });
    const fetch = vi.fn(async (_url: string, init?: { method?: string }) => {
      const refused = init?.method === 'POST';
      return { ok: !refused, status: refused ? 409 : 200, statusText: refused ? 'Conflict' : 'OK', json: async () => ({}), text: async () => (refused ? 'in progress' : body) };
    });
    vi.stubGlobal('fetch', fetch);
    await expect(ci.act('a', 1, 'rerun')).rejects.toThrow(/still running/);
    // The branch is read again once: its runs (and, since BL-8, its deployments beside them).
    expect(fetch.mock.calls.filter(([url, init]) => init?.method !== 'POST' && new URL(url).pathname.endsWith('/actions/runs'))).toHaveLength(1);
    ci.dispose();
  });
});

describe('CiRuns with the fake GitHub (the debug window)', () => {
  it('reads the fake, with no sign-in and no real token', async () => {
    const { fetch } = github({ feat: [apiRun()] });
    const { post, last } = setup();
    const ci = new CiRuns(post, 'http://127.0.0.1:4010');
    ci.update([ws('a')]);
    ci.setVisible(true);
    await settle();

    expect(auth.getSession).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:4010\/repos\/acme\/app\/actions\/runs\?branch=feat&/);
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fake-token' } });
    expect(last().a.kind).toBe('runs');
    ci.dispose();
  });

  it('does not open the sign-in dialog', async () => {
    const { post } = setup();
    const ci = new CiRuns(post, 'http://127.0.0.1:4010');
    github();
    await ci.signIn();

    expect(auth.getSession).not.toHaveBeenCalled();
    ci.dispose();
  });
});

describe('CiRuns: finished runs and reading while hidden (for the notices)', () => {
  const started = (id: number) => apiRun({ id, status: 'in_progress', conclusion: null });

  it('reports a run that finished after being seen going, not one that was done at start-up', async () => {
    const runs = github({ feat: [apiRun({ id: 1, conclusion: 'success' })] });
    const onFinished = vi.fn();
    const ci = new CiRuns(vi.fn(), undefined, onFinished);
    ci.update([ws('a')]);
    ci.setKeepReading(true);
    await settle();
    expect(onFinished).not.toHaveBeenCalled();

    runs.runs.feat = [started(2)];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFinished).not.toHaveBeenCalled();

    runs.runs.feat = [apiRun({ id: 2, conclusion: 'failure' })];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
    const [items] = onFinished.mock.calls[0];
    expect(items.map((i: { key: string; repo: string; branch: string; run: { id: number; status: string } }) => [i.key, i.repo, i.branch, i.run.id, i.run.status])).toEqual([
      ['a', 'acme/app', 'feat', 2, 'failure'],
    ]);
    ci.dispose();
  });

  it('reads nothing while hidden, unless it keeps reading for the notices, and stops when it doesn\'t', async () => {
    const { fetch } = github();
    const ci = new CiRuns(vi.fn(), undefined, vi.fn());
    ci.update([ws('a')]);
    await settle();
    expect(fetch).not.toHaveBeenCalled();

    // A read asks GitHub for the runs and for the deployments: two requests.
    ci.setKeepReading(true);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(4);

    ci.setKeepReading(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    ci.dispose();
  });
});
