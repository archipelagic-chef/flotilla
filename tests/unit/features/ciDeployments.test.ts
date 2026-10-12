import { describe, expect, it } from 'vitest';
import { GitHubDeployments, deploymentState, latestPerEnvironment, webUrl } from '../../../src/features/ci/githubDeployments';
import type { Fetch } from '../../../src/features/backlog/sources/source';

/** A fake server: answers by URL prefix (the longest match wins) and records requests. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} });
    const match = Object.keys(routes)
      .filter((r) => url.startsWith(r))
      .sort((a, b) => b.length - a.length)[0];
    const found = match !== undefined;
    return { ok: found, status: found ? 200 : 404, statusText: found ? 'OK' : 'Not Found', json: async () => routes[match!], text: async () => (found ? JSON.stringify(routes[match]) : '') };
  };
  return { fetch, calls };
}

const token = async () => 'tok';
const API = 'https://api.github.com/repos/acme/app';

describe('deployment states', () => {
  it('maps GitHub states to the four the view shows', () => {
    expect(deploymentState('success')).toBe('success');
    expect(deploymentState('failure')).toBe('failure');
    expect(deploymentState('error')).toBe('failure');
    expect(deploymentState('inactive')).toBe('inactive');
    expect(deploymentState('in_progress')).toBe('in_progress');
    expect(deploymentState('queued')).toBe('in_progress');
    expect(deploymentState('pending')).toBe('in_progress');
    expect(deploymentState(undefined)).toBe('in_progress');
    expect(deploymentState(null)).toBe('in_progress');
  });
});

describe('latestPerEnvironment', () => {
  it('keeps the newest deployment of each environment, whatever the order they come in', () => {
    const kept = latestPerEnvironment([
      { id: 1, environment: 'staging', created_at: '2026-10-09T10:00:00Z' },
      { id: 2, environment: 'production', created_at: '2026-10-08T10:00:00Z' },
      { id: 3, environment: 'staging', created_at: '2026-10-10T10:00:00Z' },
      { id: 4, environment: 'production', created_at: '2026-10-01T10:00:00Z' },
    ]);
    expect(kept.map((d) => d.id)).toEqual([3, 2]);
  });
});

describe('webUrl', () => {
  it('passes http and https links, and nothing else', () => {
    expect(webUrl('https://staging.acme.test/app')).toBe('https://staging.acme.test/app');
    expect(webUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(webUrl('javascript:alert(1)')).toBeUndefined();
    expect(webUrl('not a url')).toBeUndefined();
    expect(webUrl(null)).toBeUndefined();
    expect(webUrl('')).toBeUndefined();
  });
});

describe('GitHubDeployments', () => {
  it('lists a branch\'s deployments, one per environment, with their latest status', async () => {
    const { fetch, calls } = fakeFetch({
      [`${API}/deployments`]: [
        { id: 11, sha: 'aaa', environment: 'staging', created_at: '2026-10-10T10:00:00Z' },
        { id: 10, sha: 'bbb', environment: 'staging', created_at: '2026-10-09T10:00:00Z' },
        { id: 12, sha: 'ccc', environment: 'production', created_at: '2026-10-08T10:00:00Z' },
      ],
      [`${API}/deployments/11/statuses`]: [{ state: 'success', environment_url: 'https://staging.acme.test/', log_url: 'https://github.com/acme/app/actions/runs/1' }],
      [`${API}/deployments/12/statuses`]: [{ state: 'failure', environment_url: 'javascript:alert(1)', log_url: null }],
    });
    const deployments = new GitHubDeployments('acme', 'app', token, fetch);
    const found = await deployments.forBranch('feature/x');

    expect(found).toEqual([
      {
        id: 11,
        environment: 'staging',
        state: 'success',
        sha: 'aaa',
        created: '2026-10-10T10:00:00Z',
        url: 'https://github.com/acme/app/deployments/activity_log?environment_filter=staging',
        siteUrl: 'https://staging.acme.test/',
        logUrl: 'https://github.com/acme/app/actions/runs/1',
      },
      {
        id: 12,
        environment: 'production',
        state: 'failure',
        sha: 'ccc',
        created: '2026-10-08T10:00:00Z',
        url: 'https://github.com/acme/app/deployments/activity_log?environment_filter=production',
        siteUrl: undefined,
        logUrl: undefined,
      },
    ]);
    // The branch is the filter, and the token goes in the header only.
    const list = new URL(calls[0].url);
    expect(list.searchParams.get('ref')).toBe('feature/x');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls.some((c) => c.url.includes('/deployments/10/'))).toBe(false);
  });

  it('is empty when the branch has no deployments', async () => {
    const { fetch } = fakeFetch({ [`${API}/deployments`]: [] });
    expect(await new GitHubDeployments('acme', 'app', token, fetch).forBranch('feature/x')).toEqual([]);
  });

  it('refuses names that are not a repository', () => {
    const { fetch } = fakeFetch({});
    expect(() => new GitHubDeployments('acme/../x', 'app', token, fetch)).toThrow('Not a GitHub repository');
    expect(() => new GitHubDeployments('acme', '..', token, fetch)).toThrow('Not a GitHub repository');
  });
});
