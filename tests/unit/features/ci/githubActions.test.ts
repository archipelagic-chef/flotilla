import { describe, expect, it } from 'vitest';
import { GitHubActions, cleanLog, failureExcerpt } from '../../../../src/features/ci/githubActions';
import type { Fetch } from '../../../../src/features/backlog/sources/source';

describe('GitHubActions.runs', () => {
  it('asks for the branch\'s runs with the token, and maps them to runs', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch: Fetch = async (url, init) => {
      requests.push({ url, headers: init?.headers ?? {} });
      const body = {
        workflow_runs: [
          {
            id: 9,
            name: 'CI',
            run_number: 42,
            display_title: 'Fix the parser',
            event: 'push',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/acme/app/actions/runs/9',
            head_sha: 'abc1234',
            run_attempt: 2,
            created_at: '2026-10-11T10:00:00Z',
            updated_at: '2026-10-11T10:05:00Z',
          },
        ],
      };
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
    };
    const client = new GitHubActions('acme', 'app', async () => 'token-1', fetch);
    const [run] = await client.runs('feat/x', 5);
    expect(requests[0].url).toBe('https://api.github.com/repos/acme/app/actions/runs?branch=feat%2Fx&per_page=5');
    expect(requests[0].headers.Authorization).toBe('Bearer token-1');
    expect(run).toMatchObject({ id: 9, workflow: 'CI', number: 42, title: 'Fix the parser', status: 'failure', attempt: 2, sha: 'abc1234' });
  });

  it('refuses names that are not GitHub names', () => {
    expect(() => new GitHubActions('acme/../x', 'app', async () => '', (async () => undefined) as never)).toThrow(/Not a GitHub repository/);
  });
});

describe('log helpers', () => {
  it('cleans timestamps, colors and group markers, and keeps the error lines of a long log', () => {
    const log = [
      '2026-10-11T10:00:00.1234567Z ##[group]Run tests',
      '2026-10-11T10:00:01.0000000Z \u001b[31mERROR\u001b[0m: boom',
      '2026-10-11T10:00:02.0000000Z ##[endgroup]',
      ...Array.from({ length: 200 }, (_, i) => `2026-10-11T10:01:00.0000000Z line ${i}`),
    ].join('\n');
    const cleaned = cleanLog(log);
    expect(cleaned.split('\n')[0]).toBe('▸ Run tests');
    const excerpt = failureExcerpt(log, 50).split('\n');
    expect(excerpt.length).toBeLessThanOrEqual(52);
    expect(excerpt[0]).toBe('ERROR: boom');
    expect(excerpt).toContain('…');
    expect(excerpt.at(-1)).toBe('line 199');
  });
});
