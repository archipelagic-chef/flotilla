import { describe, expect, it } from 'vitest';
import { GitHubActions, ciStatus, isActive, splitUpstream } from '../../../../src/features/ci/githubActions';
import type { Fetch } from '../../../../src/features/backlog/sources/source';

/** A fake GitHub: answers by URL prefix and records the requests. */
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

describe('ciStatus', () => {
  it('maps a run that is waiting or going on', () => {
    expect(ciStatus('queued', null)).toBe('queued');
    expect(ciStatus('waiting', null)).toBe('queued');
    expect(ciStatus('in_progress', null)).toBe('running');
  });

  it('maps a finished run by its conclusion', () => {
    expect(ciStatus('completed', 'success')).toBe('success');
    expect(ciStatus('completed', 'cancelled')).toBe('cancelled');
    expect(ciStatus('completed', 'skipped')).toBe('skipped');
    expect(ciStatus('completed', 'neutral')).toBe('neutral');
    expect(ciStatus('completed', 'failure')).toBe('failure');
  });

  it('counts every other conclusion as a failure', () => {
    for (const conclusion of ['timed_out', 'action_required', 'startup_failure', 'stale']) expect(ciStatus('completed', conclusion)).toBe('failure');
    expect(ciStatus('completed', null)).toBe('failure');
  });

  it('knows which statuses are still going', () => {
    expect(isActive('queued')).toBe(true);
    expect(isActive('running')).toBe(true);
    expect(isActive('success')).toBe(false);
    expect(isActive('failure')).toBe(false);
  });
});

describe('splitUpstream', () => {
  it('splits the remote from the branch', () => {
    expect(splitUpstream('origin/feat/x', ['origin'])).toEqual({ remote: 'origin', branch: 'feat/x' });
  });

  it('prefers the longest remote that fits, when a remote name has a slash', () => {
    expect(splitUpstream('team/fork/main', ['team', 'team/fork'])).toEqual({ remote: 'team/fork', branch: 'main' });
    // "origin/x" is the branch "x" of remote "origin" here, not of a remote called "origin/x".
    expect(splitUpstream('origin/x', ['origin', 'origin/x'])).toEqual({ remote: 'origin', branch: 'x' });
  });

  it('is undefined when no remote fits', () => {
    expect(splitUpstream('upstream/main', ['origin'])).toBeUndefined();
    expect(splitUpstream('origin', ['origin'])).toBeUndefined();
  });
});

describe('GitHubActions', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'CI',
    run_number: 42,
    display_title: 'Fix the parser',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/acme/app/actions/runs/7',
    head_sha: 'abc123',
    created_at: '2026-10-11T10:00:00Z',
    updated_at: '2026-10-11T10:05:00Z',
    ...over,
  });

  it('reads a branch\'s latest runs with the token and the API version', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.github.com/repos/acme/app/actions/runs': { workflow_runs: [run()] } });
    const runs = await new GitHubActions('acme', 'app', async () => 'tok', fetch).runs('feat/x');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/app/actions/runs?branch=feat%2Fx&per_page=10');
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'X-GitHub-Api-Version': '2022-11-28' });
    expect(runs).toEqual([
      {
        id: 7,
        workflow: 'CI',
        number: 42,
        title: 'Fix the parser',
        event: 'push',
        status: 'failure',
        url: 'https://github.com/acme/app/actions/runs/7',
        sha: 'abc123',
        created: '2026-10-11T10:00:00Z',
      },
    ]);
  });

  it('takes the title from the commit message when there is no display title, and a name for a run without one', async () => {
    const { fetch } = fakeFetch({
      'https://api.github.com/': { workflow_runs: [run({ display_title: undefined, head_commit: { message: 'Subject\n\nBody' }, name: null, status: 'in_progress', conclusion: null })] },
    });
    const [r] = await new GitHubActions('acme', 'app', async () => 'tok', fetch).runs('main');
    expect(r).toMatchObject({ title: 'Subject', workflow: 'Workflow', status: 'running' });
  });

  it('asks for the number of runs it is given', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.github.com/': { workflow_runs: [] } });
    await new GitHubActions('acme', 'app', async () => 'tok', fetch).runs('main', 3);
    expect(calls[0].url).toContain('per_page=3');
  });

  it('rejects names that are not GitHub owners or repositories, before any request', () => {
    const { fetch, calls } = fakeFetch({});
    expect(() => new GitHubActions('acme/../x', 'app', async () => 'tok', fetch)).toThrow('Not a GitHub repository');
    expect(() => new GitHubActions('acme', '..', async () => 'tok', fetch)).toThrow('Not a GitHub repository');
    expect(calls).toHaveLength(0);
  });

  it('throws the API error when GitHub refuses', async () => {
    const { fetch } = fakeFetch({});
    await expect(new GitHubActions('acme', 'app', async () => 'tok', fetch).runs('main')).rejects.toThrow('404 Not Found');
  });

  describe('jobs', () => {
    const jobsUrl = 'https://api.github.com/repos/acme/app/actions/runs/7/jobs';
    const job = (id: number) => ({ id, name: `job ${id}`, status: 'completed', conclusion: 'success', html_url: `https://github.com/acme/app/runs/7/job/${id}`, steps: [] });

    /** A fake GitHub with paged jobs: each page links to the next one through the Link header, as GitHub does. */
    function pagedFetch(pages: Array<{ jobs: unknown[]; link?: string }>) {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const fetch: Fetch = async (url, init) => {
        calls.push({ url, headers: init?.headers ?? {} });
        const page = Number(new URL(url).searchParams.get('page') ?? 1);
        const found = pages[page - 1];
        if (!found) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}), text: async () => '' };
        const link = found.link;
        const body = { total_count: pages.reduce((n, p) => n + p.jobs.length, 0), jobs: found.jobs };
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => body,
          text: async () => JSON.stringify(body),
          headers: { get: (name: string) => (name.toLowerCase() === 'link' ? (link ?? null) : null) },
        };
      };
      return { fetch, calls };
    }

    it('reads every page of a run with more jobs than one page holds', async () => {
      const first = Array.from({ length: 100 }, (_, i) => job(i + 1));
      const second = [job(101), job(102)];
      const { fetch, calls } = pagedFetch([
        { jobs: first, link: `<${jobsUrl}?per_page=100&page=2>; rel="next", <${jobsUrl}?per_page=100&page=2>; rel="last"` },
        { jobs: second },
      ]);
      const jobs = await new GitHubActions('acme', 'app', async () => 'tok', fetch).jobs(7);
      expect(jobs.map((j) => j.id)).toEqual([...first.map((j) => j.id), 101, 102]);
      expect(calls.map((c) => c.url)).toEqual([`${jobsUrl}?per_page=100`, `${jobsUrl}?per_page=100&page=2`]);
      expect(calls[1].headers).toMatchObject({ Authorization: 'Bearer tok' });
    });

    it('reads one page when there is no next link', async () => {
      const { fetch, calls } = pagedFetch([{ jobs: [job(1)] }]);
      expect((await new GitHubActions('acme', 'app', async () => 'tok', fetch).jobs(7)).map((j) => j.id)).toEqual([1]);
      expect(calls).toHaveLength(1);
    });

    it('says how many jobs it left out when a run has more pages than it reads', async () => {
      const pages = Array.from({ length: 21 }, (_, i) => ({ jobs: [job(i + 1)], link: `<${jobsUrl}?per_page=100&page=${i + 2}>; rel="next"` }));
      const { fetch, calls } = pagedFetch(pages);
      await expect(new GitHubActions('acme', 'app', async () => 'tok', fetch).jobs(7)).rejects.toThrow("Read 20 of 21 jobs; the rest weren't read.");
      expect(calls).toHaveLength(20);
    });

    it("doesn't send the token to a next link that isn't on api.github.com", async () => {
      const { fetch, calls } = pagedFetch([{ jobs: [job(1)], link: '<https://example.com/steal?page=2>; rel="next"' }]);
      await expect(new GitHubActions('acme', 'app', async () => 'tok', fetch).jobs(7)).rejects.toThrow("isn't on api.github.com");
      expect(calls).toHaveLength(1);
    });
  });
});
