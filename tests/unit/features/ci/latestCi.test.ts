import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  type FakeGitHub,
  startFakeGitHub,
} from '../../../../scripts/fake-github.mjs';
import { GitHubActions } from '../../../../src/features/ci/githubActions';
import {
  latestCi,
  tookLabel,
} from '../../../../src/features/ci/summary';
import type { Fetch } from '../../../../src/features/backlog/sources/source';
import type {
  CiRunView,
  CiView,
} from '../../../../src/webview/protocol';

const run = (over: Partial<CiRunView>): CiRunView => ({
  id: 1,
  workflow: 'CI',
  number: 1,
  title: 'A commit',
  event: 'push',
  status: 'success',
  url: 'https://github.com/acme/app/actions/runs/1',
  sha: 'new',
  attempt: 1,
  created: '2026-10-11T10:00:00Z',
  current: false,
  ...over,
});
const runs = (...rs: CiRunView[]): CiView => ({ kind: 'runs', repo: 'acme/app', branch: 'feat', runs: rs, deployments: [] });

describe('latestCi: the CI line of a ticket', () => {
  it('shows nothing for a branch without CI: no runs, not published, not on GitHub, not signed in, or not read yet', () => {
    expect(latestCi(undefined)).toBeUndefined();
    expect(latestCi(runs())).toBeUndefined();
    for (const view of [{ kind: 'unpublished' }, { kind: 'unsupported' }, { kind: 'signIn' }, { kind: 'error', error: 'x' }] as CiView[]) {
      expect(latestCi(view)).toBeUndefined();
    }
  });

  it('takes the newest run, timed from its start to now while it goes', () => {
    const view = runs(run({ id: 4, status: 'running', started: '2026-10-11T10:00:30Z' }), run({ id: 2, status: 'failure' }));
    const ci = latestCi(view, Date.parse('2026-10-11T10:03:30Z'))!;
    expect([ci.run.id, ci.took]).toEqual([4, 180_000]);
  });

  it('times a finished run to its last update, and a queued one from when it was made', () => {
    const done = runs(run({ status: 'success', started: '2026-10-11T10:00:00Z', updated: '2026-10-11T10:04:00Z' }));
    expect(latestCi(done, Date.parse('2026-10-12T00:00:00Z'))!.took).toBe(240_000);
    const queued = runs(run({ status: 'queued' }));
    expect(latestCi(queued, Date.parse('2026-10-11T10:00:05Z'))!.took).toBe(5_000);
  });

  it('says the time taken in seconds, minutes or hours', () => {
    expect([tookLabel(45_900), tookLabel(187_000), tookLabel(3_720_000)]).toEqual(['45s', '3m 07s', '1h 02m']);
  });
});

describe('latestCi against the fake GitHub', () => {
  // The fake's timeline (scripts/fake-github.mjs): a run waits 6 s, then its jobs run for 25 s.
  const T0 = Date.parse('2026-10-12T16:00:00Z');
  let clock = T0;
  let fake: FakeGitHub;
  beforeEach(async () => {
    clock = T0;
    fake = await startFakeGitHub({ port: 0, now: () => clock });
  });
  afterEach(async () => {
    await fake.close();
  });

  const line = async () => {
    const read = await new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url).runs('feat');
    const ci = latestCi(runs(...read.map((r) => ({ ...r, current: false }))), clock)!;
    return `${ci.run.workflow} #${ci.run.number} ${ci.run.status} ${tookLabel(ci.took)}`;
  };

  it('goes from queued to running to failed, its time counting up while it goes and stopping when it ends', async () => {
    expect(await line()).toBe('CI #3 queued 0s');
    clock = T0 + 10_000;
    expect(await line()).toBe('CI #3 running 10s');
    clock = T0 + 31_000;
    expect(await line()).toBe('CI #3 failure 31s');
    clock = T0 + 600_000;
    expect(await line()).toBe('CI #3 failure 31s');
  });

  it('goes from running to passed when the failed run is run again', async () => {
    expect(await line()).toBe('CI #3 queued 0s');
    clock = T0 + 31_000;
    expect(await line()).toBe('CI #3 failure 31s');
    const [failed] = await new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url).runs('feat');
    await new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url).rerun(failed.id, false);
    clock += 10_000;
    expect(await line()).toBe('CI #3 running 10s');
    clock += 21_000;
    expect(await line()).toBe('CI #3 success 31s');
  });
});
