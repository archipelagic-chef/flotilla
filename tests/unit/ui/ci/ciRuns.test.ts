import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CiRuns } from '../../../../src/ui/ci/ciRuns';
import type { Workstream } from '../../../../src/features/workstreams/workstream';
import type { CiView } from '../../../../src/webview/protocol';

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
const git = vi.hoisted(() => ({ runGit: vi.fn() }));

vi.mock('vscode', () => ({ authentication: auth }));
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
  const fetch = vi.fn(async (url: string) => {
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
