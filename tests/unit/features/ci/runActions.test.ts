import { describe, expect, it } from 'vitest';
import { explainRunError, RunControls, runActions } from '../../../../src/features/ci/runActions';
import type { Fetch } from '../../../../src/features/backlog/sources/source';

/** A fake GitHub: answers each request with the given status (and body), and records requests. */
function fakeGitHub(status: number, body = '') {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} });
    const ok = status >= 200 && status < 300;
    return { ok, status, statusText: ok ? 'Accepted' : 'Error', json: async () => ({}), text: async () => body };
  };
  return { fetch, calls };
}

const controls = (fetch: Fetch) => new RunControls('acme', 'app', async () => 'tok', fetch);

describe('runActions', () => {
  it('offers re-run for a finished run, and re-run failed jobs when one failed', () => {
    expect(runActions({ active: false, failed: false })).toEqual(['rerun']);
    expect(runActions({ active: false, failed: true })).toEqual(['rerun', 'rerunFailed']);
  });

  it('offers only cancel for a queued or running run', () => {
    expect(runActions({ active: true, failed: false })).toEqual(['cancel']);
    expect(runActions({ active: true, failed: true })).toEqual(['cancel']);
  });
});

describe('RunControls', () => {
  it('posts a re-run, or a re-run of the failed jobs, with the token', async () => {
    const { fetch, calls } = fakeGitHub(201);
    await controls(fetch).rerun(42, false);
    await controls(fetch).rerun(42, true);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://api.github.com/repos/acme/app/actions/runs/42/rerun'],
      ['POST', 'https://api.github.com/repos/acme/app/actions/runs/42/rerun-failed-jobs'],
    ]);
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('posts a cancel', async () => {
    const { fetch, calls } = fakeGitHub(202);
    await controls(fetch).cancel(7);
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app/actions/runs/7/cancel');
  });

  it('refuses ids and names that would reach other API routes', async () => {
    const { fetch, calls } = fakeGitHub(200);
    await expect(controls(fetch).cancel(-1)).rejects.toThrow('Not a GitHub Actions run id');
    await expect(controls(fetch).rerun(1.5, false)).rejects.toThrow('Not a GitHub Actions run id');
    expect(() => new RunControls('acme/../x', 'app', async () => 'tok', fetch)).toThrow('Not a GitHub repository');
    expect(calls).toHaveLength(0);
  });

  it('says what to do when GitHub refuses, not the raw status', async () => {
    const forbidden = fakeGitHub(403, 'Resource not accessible by integration');
    await expect(controls(forbidden.fetch).rerun(1, false)).rejects.toThrow(/write access to the repository/);
    const old = fakeGitHub(403, 'This workflow run is too old to be re-run');
    await expect(controls(old.fetch).rerun(1, false)).rejects.toThrow(/too old/);
    const gone = fakeGitHub(404, 'Not Found');
    await expect(controls(gone.fetch).cancel(1)).rejects.toThrow(/doesn't find this run in acme\/app/);
    const finished = fakeGitHub(409, 'Cannot cancel a workflow run that is completed.');
    await expect(controls(finished.fetch).cancel(1)).rejects.toThrow(/already finished/);
  });

  it('passes other failures through as a message', async () => {
    const { fetch } = fakeGitHub(503, 'Unavailable');
    await expect(controls(fetch).rerun(1, true)).rejects.toThrow("GitHub didn't re-run the run (503: Unavailable)");
    const offline = (async () => {
      throw new Error('api.github.com didn\'t answer within 20 seconds.');
    }) as Fetch;
    await expect(controls(offline).cancel(1)).rejects.toThrow("didn't answer within 20 seconds");
  });
});

describe('explainRunError', () => {
  it('tells the user to sign in again when the token is refused', () => {
    expect(explainRunError('cancel', 401, '', 'acme/app')).toMatch(/Sign in to GitHub again/);
  });

  it('says a failed-jobs re-run has nothing to re-run', () => {
    expect(explainRunError('rerunFailed', 422, '', 'acme/app')).toMatch(/no job in this run failed/);
  });
});
