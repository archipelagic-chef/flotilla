import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { startFakeGitHub, type FakeGitHub } from '../../../scripts/fake-github.mjs';
import {
  type CiDecision,
  commitRuns,
  decideCi,
  failedNote,
  passedNote,
  runsVerdict,
} from '../../../src/features/backlog/mergeCi';
import { GitHubActions, type CiRun } from '../../../src/features/ci/githubActions';
import type { Fetch } from '../../../src/features/backlog/sources/source';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

// The fake's timeline (scripts/fake-github.mjs): a branch's first read makes its runs; the CI run then waits 6 s, runs
// for 25 s and fails in its tests. Run again, it passes.
const DONE_MS = 40_000;
const T0 = Date.parse('2026-10-12T16:00:00Z');
const BRANCH = 'feature/BL-1-one';

const run = (over: Partial<CiRun>): CiRun => ({
  id: 1,
  workflow: 'CI',
  number: 1,
  title: '',
  event: 'push',
  status: 'success',
  url: '',
  sha: 'a',
  attempt: 1,
  created: '',
  ...over,
});

describe("the runs that decide a commit's CI", () => {
  it('takes the latest run of each workflow on the commit, and none of other commits', () => {
    const runs = [
      run({ id: 1, number: 1, status: 'failure' }),
      run({ id: 2, number: 2 }),
      run({ id: 3, workflow: 'Lint', number: 7, status: 'running' }),
      run({ id: 4, number: 3, sha: 'b', status: 'failure' }),
    ];

    expect(commitRuns(runs, 'a').map((r) => r.id)).toEqual([2, 3]);
  });

  it('is red on one failed or cancelled run, running while one goes on (or none is there yet), else green', () => {
    expect(runsVerdict([run({}), run({ status: 'skipped' }), run({ status: 'neutral' })])).toBe('passed');
    expect(runsVerdict([run({}), run({ status: 'queued' })])).toBe('running');
    expect(runsVerdict([])).toBe('running');
    expect(runsVerdict([run({ status: 'running' }), run({ status: 'cancelled' })])).toBe('failed');
    expect(runsVerdict([run({ status: 'failure' })])).toBe('failed');
  });
});

describe('Merge to main deciding on CI, against the fake GitHub', () => {
  let clock = T0;
  let fake: FakeGitHub;
  let repo: string;
  let origin: string;

  beforeEach(async () => {
    clock = T0;
    repo = initRepo();
    origin = makeTempDir();
    git(origin, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', origin);
    writeFile(repo, '.github/workflows/ci.yml', 'name: CI\non: [push]\njobs: {}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'CI');
    git(repo, 'checkout', '-q', '-b', BRANCH);
    writeFile(repo, 'a.txt', 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'BL-1: a');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'push', '-q', 'origin', BRANCH);
    fake = await startFakeGitHub({ port: 0, repoDir: repo, now: () => clock });
  });

  afterEach(async () => {
    await fake.close();
    removeDir(repo);
    removeDir(origin);
  });

  const reader = () => new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url);
  const decide = (o: { reader?: ReturnType<typeof reader> | string; setting?: 'ci' | 'local'; pushError?: string } = {}): Promise<CiDecision> =>
    decideCi({
      cwd: repo,
      setting: o.setting ?? 'ci',
      branch: BRANCH,
      tip: git(repo, 'rev-parse', BRANCH),
      baseTip: git(repo, 'rev-parse', 'main'),
      reader: o.reader ?? reader(),
      pushError: o.pushError,
      now: clock,
    });
  const rerun = (id: number) => fetch(`${fake.url}/repos/playground/app/actions/runs/${id}/rerun`, { method: 'POST' });

  it('waits while CI runs, is red once it fails, and green once it passes run again', async () => {
    const running = await decide();
    expect(running).toMatchObject({ kind: 'running', tip: git(repo, 'rev-parse', BRANCH) });
    expect(running.kind === 'running' && running.runs.map((r) => [r.workflow, r.number, r.status])).toEqual([
      ['CI', 3, 'queued'],
      ['Deploy', 1, 'success'],
    ]);

    clock += DONE_MS;
    const failed = await decide();
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed') return;
    expect(failed.runs.map((r) => r.number)).toEqual([3]);
    expect(failed.jobs.map((j) => [j.job.name, j.job.status])).toEqual([['test', 'failure']]);
    const note = failedNote(failed, BRANCH);
    expect(note).toContain('Not merged: CI failed on `feature/BL-1-one`');
    expect(note).toContain(`- Failed: [test](${failed.jobs[0].job.url}) in [CI #3](${failed.runs[0].url})`);

    expect((await rerun(failed.runs[0].id)).status).toBe(201);
    clock += DONE_MS;
    const passed = await decide();
    expect(passed.kind).toBe('passed');
    if (passed.kind !== 'passed') return;
    expect(passedNote(passed)).toBe(
      `CI passed on \`${passed.tip.slice(0, 7)}\`: [CI #3](${passed.runs[0].url}), [Deploy #1](${passed.runs[1].url}); no checks ran locally.`,
    );
  });

  it("doesn't decide on CI once main has moved on since the branch took it in", async () => {
    writeFile(repo, 'm.txt', 'm\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moves on');

    expect(await decide()).toEqual({ kind: 'moved', tip: git(repo, 'rev-parse', BRANCH) });
  });

  it('runs the checks locally, saying why, when there is no CI for the tip', async () => {
    expect(await decide({ setting: 'local' })).toEqual({ kind: 'local' });
    expect(await decide({ reader: "you aren't signed in to GitHub." })).toEqual({ kind: 'local', why: "you aren't signed in to GitHub." });

    // A commit that isn't pushed (its push failed). GitHub has the branch's runs of its first commit only.
    fake.seed('playground/app', BRANCH);
    git(repo, 'checkout', '-q', BRANCH);
    writeFile(repo, 'b.txt', 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'BL-1: b');
    git(repo, 'checkout', '-q', 'main');
    const tip = git(repo, 'rev-parse', BRANCH).slice(0, 7);
    expect(await decide({ pushError: 'rejected' })).toEqual({ kind: 'local', why: `\`${BRANCH}\`'s tip \`${tip}\` isn't pushed: its push failed (rejected).` });

    // Pushed long ago, and no workflow ran on it.
    git(repo, 'push', '-q', 'origin', BRANCH);
    clock = Date.now() + 10 * 60_000;
    expect(await decide()).toEqual({ kind: 'local', why: `no workflow ran on \`${tip}\` on GitHub.` });
    // Just pushed: GitHub may not have started its runs yet, so it waits.
    clock = Date.now();
    expect(await decide()).toEqual({ kind: 'running', tip: git(repo, 'rev-parse', BRANCH), runs: [] });
  });

  it('runs the checks locally when no workflow runs on push', async () => {
    git(repo, 'checkout', '-q', BRANCH);
    writeFile(repo, '.github/workflows/ci.yml', 'name: CI\non: [workflow_dispatch]\njobs: {}\n');
    git(repo, 'commit', '-q', '-am', 'BL-1: CI by hand');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'push', '-q', 'origin', BRANCH);

    expect(await decide()).toEqual({ kind: 'local', why: `no workflow in \`${BRANCH}\`'s \`.github/workflows\` runs on push.` });
  });
});
