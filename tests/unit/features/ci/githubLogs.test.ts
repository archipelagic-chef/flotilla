import { describe, expect, it } from 'vitest';
import { cleanLog, GitHubActions } from '../../../../src/features/ci/githubActions';
import type { Fetch } from '../../../../src/features/backlog/sources/source';

interface Reply {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A fake server: answers by URL prefix (the longest match) and records what each request sent. */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, redirect: init?.redirect });
    const match = Object.keys(routes)
      .filter((r) => url.startsWith(r))
      .sort((a, b) => b.length - a.length)[0];
    const reply: Reply = match === undefined ? { status: 404, statusText: 'Not Found' } : routes[match];
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? '');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: reply.statusText ?? '',
      json: async () => JSON.parse(text),
      text: async () => text,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
    };
  };
  return { fetch, calls };
}

const api = 'https://api.github.com/repos/acme/app/actions';
const actions = (fetch: Fetch) => new GitHubActions('acme', 'app', async () => 'secret-token', fetch);

describe('cleanLog', () => {
  it('drops each line’s time stamp and the ANSI colors', () => {
    const log = '﻿2026-10-11T15:00:01.1234567Z \x1b[31mred\x1b[0m output\n2026-10-11T15:00:02Z done';
    expect(cleanLog(log)).toBe('red output\ndone');
  });

  it('shows groups and annotations readably', () => {
    const log = [
      '2026-10-11T15:00:01Z ##[group]Run npm test',
      '2026-10-11T15:00:02Z npm ERR! failed',
      '2026-10-11T15:00:03Z ##[error]Process completed with exit code 1.',
      '2026-10-11T15:00:04Z ##[warning]Deprecated',
      '2026-10-11T15:00:05Z ##[endgroup]',
    ].join('\n');
    expect(cleanLog(log).split('\n')).toEqual(['▸ Run npm test', 'npm ERR! failed', 'ERROR: Process completed with exit code 1.', 'WARNING: Deprecated', '']);
  });

  it('collapses runs of blank lines into one', () => {
    expect(cleanLog('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('GitHubActions.log', () => {
  it('reads the redirect by hand and fetches the storage without the token', async () => {
    const storage = 'https://pipelines.actions.githubusercontent.com/abc/log';
    const { fetch, calls } = fakeFetch({
      [`${api}/jobs/7/logs`]: { status: 302, headers: { location: storage } },
      [storage]: { status: 200, body: '2026-10-11T15:00:01Z hello' },
    });
    expect(await actions(fetch).log(7)).toBe('2026-10-11T15:00:01Z hello');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: `${api}/jobs/7/logs`, redirect: 'manual' });
    expect(calls[0].headers.Authorization).toBe('Bearer secret-token');
    expect(calls[1].url).toBe(storage);
    expect(calls[1].headers).not.toHaveProperty('Authorization');
  });

  it('refuses a log kept over anything but https', async () => {
    const { fetch } = fakeFetch({ [`${api}/jobs/7/logs`]: { status: 302, headers: { location: 'http://storage.test/log' } } });
    await expect(actions(fetch).log(7)).rejects.toThrow(/not over https/);
  });

  it('reports an error answer from GitHub', async () => {
    const { fetch } = fakeFetch({ [`${api}/jobs/7/logs`]: { status: 404, statusText: 'Not Found' } });
    await expect(actions(fetch).log(7)).rejects.toThrow('404 Not Found');
  });

  it('sends nothing for a job id that isn’t a whole number', async () => {
    const { fetch, calls } = fakeFetch({});
    for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(actions(fetch).log(bad)).rejects.toThrow('Not a GitHub Actions id');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('GitHubActions.jobs', () => {
  it('maps jobs and their steps', async () => {
    const { fetch, calls } = fakeFetch({
      [`${api}/runs/3/jobs`]: {
        status: 200,
        body: {
          jobs: [
            {
              id: 9,
              name: 'test',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/acme/app/actions/runs/3/job/9',
              started_at: '2026-10-11T15:00:00Z',
              completed_at: '2026-10-11T15:02:00Z',
              steps: [
                { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
                { number: 2, name: 'Test', status: 'completed', conclusion: 'failure' },
                { number: 3, name: 'Upload', status: 'queued', conclusion: null },
              ],
            },
          ],
        },
      },
    });
    const [job] = await actions(fetch).jobs(3);
    expect(calls[0].url).toBe(`${api}/runs/3/jobs?per_page=100`);
    expect(job).toMatchObject({ id: 9, name: 'test', status: 'failure', started: '2026-10-11T15:00:00Z' });
    expect(job.steps.map((s) => [s.name, s.status])).toEqual([
      ['Checkout', 'success'],
      ['Test', 'failure'],
      ['Upload', 'queued'],
    ]);
  });
});
