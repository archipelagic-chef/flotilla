import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeGitHub } from '../../../../scripts/fake-github.mjs';
import { fakeApiOrigin, GitHubActions, type CiRun } from '../../../../src/features/ci/githubActions';
import type { Fetch } from '../../../../src/features/backlog/sources/source';
import { git, initRepo, makeTempDir, removeDir } from '../../../helpers/gitRepo';

// The fake's timeline (scripts/fake-github.mjs): a run waits 6 s, then its jobs run for 25 s.
const QUEUE_MS = 6_000;
const RUN_MS = 25_000;
const T0 = Date.parse('2026-10-12T16:00:00Z');
const REPO = '/repos/playground/app/actions';

let clock = T0;
let fake: FakeGitHub;

beforeEach(async () => {
  clock = T0;
  fake = await startFakeGitHub({ port: 0, now: () => clock });
});

afterEach(async () => {
  await fake.close();
});

/** Flotilla's client, pointed at the fake, with a placeholder token (the fake doesn't check it). */
const actions = () => new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url);

const ci = (runs: CiRun[]) => runs.filter((r) => r.workflow === 'CI');

async function call(method: string, path: string, body?: unknown) {
  return fetch(`${fake.url}${REPO}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

describe('the fake GitHub, read by the CI/CD view', () => {
  it("serves a branch's runs, newest first, to the client", async () => {
    const runs = await actions().runs('main');

    expect(runs.map((r) => [r.workflow, r.number, r.status])).toEqual([
      ['CI', 3, 'queued'],
      ['Deploy', 1, 'success'],
      ['CI', 2, 'success'],
      ['CI', 1, 'success'],
    ]);
    expect(runs[0].url).toBe('https://github.com/playground/app/actions/runs/1003');
  });

  it('moves the newest run on by the clock: queued, running, then failure', async () => {
    const statuses = async () => ci(await actions().runs('main'))[0].status;

    expect(await statuses()).toBe('queued');
    clock = T0 + QUEUE_MS + 1_000;
    expect(await statuses()).toBe('running');
    clock = T0 + QUEUE_MS + RUN_MS;
    expect(await statuses()).toBe('failure');
  });

  it('answers no runs for a branch the repository lacks', async () => {
    const dir = initRepo(makeTempDir('fake-github-'));
    try {
      const withRepo = await startFakeGitHub({ port: 0, repoDir: dir, now: () => clock });
      try {
        const client = new GitHubActions('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, withRepo.url);
        expect(await client.runs('no-such-branch')).toEqual([]);
        const runs = await client.runs('main');
        // The runs carry the commit the branch points at, and a dispatch needs a branch that's there.
        expect(runs.map((r) => r.sha)).toEqual(Array(runs.length).fill(git(dir, 'rev-parse', 'main')));
        const dispatch = await fetch(`${withRepo.url}${REPO}/workflows/deploy.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'nope' }) });
        expect(dispatch.status).toBe(422);
      } finally {
        await withRepo.close();
      }
    } finally {
      removeDir(dir);
    }
  });

  it('fails the CI run in its tests, with the log of a failing run', async () => {
    const id = ci(await actions().runs('main'))[0].id;
    clock = T0 + QUEUE_MS + RUN_MS;

    const jobs = (await (await call('GET', `/runs/${id}/jobs`)).json()) as { jobs: Array<{ id: number; name: string; conclusion: string; steps: Array<{ name: string; conclusion: string }> }> };
    const test = jobs.jobs.find((j) => j.name === 'test')!;
    expect(test.conclusion).toBe('failure');
    expect(test.steps.find((s) => s.name === 'Run tests')?.conclusion).toBe('failure');
    expect(test.steps.find((s) => s.name === 'Complete job')?.conclusion).toBe('success');
    expect(jobs.jobs.find((j) => j.name === 'lint')?.conclusion).toBe('success');

    // The log is kept elsewhere: the API redirects to it (not followed here).
    const redirect = await call('GET', `/jobs/${test.id}/logs`);
    expect(redirect.status).toBe(302);
    const log = await (await fetch(redirect.headers.get('location')!)).text();
    expect(log).toContain('FAIL  tests/cart.test.ts');
    expect(log).toContain('AssertionError: expected 10.79 to be 10.8');
    expect(log).toContain('##[error]Process completed with exit code 1.');
  });

  it('cancels a run going on, and re-runs it once it has finished', async () => {
    const id = ci(await actions().runs('main'))[0].id;
    expect((await call('POST', `/runs/${id}/cancel`)).status).toBe(202);
    expect(ci(await actions().runs('main'))[0].status).toBe('cancelled');
    expect((await call('POST', `/runs/${id}/cancel`)).status).toBe(409);

    expect((await call('POST', `/runs/${id}/rerun-failed-jobs`, {})).status).toBe(201);
    expect(ci(await actions().runs('main'))[0].status).toBe('queued');
    expect((await call('POST', `/runs/${id}/rerun`, {})).status).toBe(409);

    clock = T0 + QUEUE_MS + RUN_MS;
    expect(ci(await actions().runs('main'))[0].status).toBe('failure');
    expect((await call('POST', `/runs/${id}/rerun`, {})).status).toBe(201);
    expect(ci(await actions().runs('main'))[0].status).toBe('queued');
  });

  it('dispatches a workflow on a branch, and refuses what GitHub would', async () => {
    expect((await call('POST', '/workflows/deploy.yml/dispatches', { ref: 'main' })).status).toBe(204);
    const deploys = (await actions().runs('main')).filter((r) => r.workflow === 'Deploy');
    expect(deploys.map((r) => [r.number, r.event])).toEqual([
      [2, 'workflow_dispatch'],
      [1, 'workflow_dispatch'],
    ]);

    expect((await call('POST', '/workflows/ci.yml/dispatches', { ref: 'main' })).status).toBe(422);
  });

  it('answers 404 for what it does not have', async () => {
    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('GET', '/runs/1/jobs')).status).toBe(404);
  });
});

describe('fakeApiOrigin', () => {
  it('accepts plain http on this machine', () => {
    expect(fakeApiOrigin('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010');
    expect(fakeApiOrigin(' http://localhost:4010/ ')).toBe('http://localhost:4010');
    expect(fakeApiOrigin('http://[::1]:4010')).toBe('http://[::1]:4010');
  });

  it('refuses anything else, so no token is sent elsewhere', () => {
    expect(fakeApiOrigin('')).toBeUndefined();
    expect(fakeApiOrigin('not a url')).toBeUndefined();
    expect(fakeApiOrigin('https://api.github.com')).toBeUndefined();
    expect(fakeApiOrigin('http://api.github.com')).toBeUndefined();
    expect(fakeApiOrigin('http://192.168.1.10:4010')).toBeUndefined();
  });
});
