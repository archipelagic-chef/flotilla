import { describe, expect, it } from 'vitest';
import { GitHubSource, gitHubRepo } from '../../../src/features/backlog/sources/github';
import { JiraSource, jiraStatus } from '../../../src/features/backlog/sources/jira';
import type { Fetch } from '../../../src/features/backlog/sources/source';

/** A fake server: answers by URL prefix and records requests. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const match = Object.keys(routes)
      .filter((r) => url.startsWith(r))
      .sort((a, b) => b.length - a.length)[0];
    const found = match !== undefined;
    return { ok: found, status: found ? 200 : 404, statusText: found ? 'OK' : 'Not Found', json: async () => routes[match!], text: async () => '' };
  };
  return { fetch, calls };
}

describe('Jira', () => {
  const config = { kind: 'jira' as const, id: 'jira-1', site: 'https://acme.atlassian.net/', email: 'me@acme.test', jql: 'project = ABC' };

  it('lists issues in lanes by status category, with basic auth', async () => {
    const { fetch, calls } = fakeFetch({
      'https://acme.atlassian.net/rest/api/3/search/jql': {
        issues: [
          { key: 'ABC-1', fields: { summary: 'One', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } },
          { key: 'ABC-2', fields: { summary: 'Two', status: { name: 'Closed', statusCategory: { key: 'done' } } } },
        ],
      },
    });
    const jira = new JiraSource(config, 'tok', fetch);
    expect(jira.label).toBe('Jira acme');
    const issues = await jira.list();
    expect(issues).toEqual([
      { id: 'ABC-1', title: 'One', status: 'doing', statusName: 'In Review', url: 'https://acme.atlassian.net/browse/ABC-1', source: 'jira-1' },
      { id: 'ABC-2', title: 'Two', status: 'done', statusName: 'Closed', url: 'https://acme.atlassian.net/browse/ABC-2', source: 'jira-1' },
    ]);
    expect(new URL(calls[0].url).searchParams.get('jql')).toBe('project = ABC');
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.test:tok').toString('base64')}`);
    expect(jiraStatus(undefined)).toBe('todo');
  });

  it('reads details with rendered HTML, and posts comments', async () => {
    const { fetch, calls } = fakeFetch({
      'https://acme.atlassian.net/rest/api/2/issue/ABC-1/comment': {},
      'https://acme.atlassian.net/rest/api/2/issue/ABC-1': {
        key: 'ABC-1',
        fields: { summary: 'One', description: 'h1. Hi', comment: { comments: [{ author: { displayName: 'Kim' }, created: '2026-10-10T10:00:00Z', body: '*raw*' }] } },
        renderedFields: { description: '<h1>Hi</h1>', comment: { comments: [{ created: '2026-10-10T10:00:00Z', body: '<b>raw</b>' }] } },
      },
    });
    const jira = new JiraSource(config, 'tok', fetch);
    const d = await jira.details('ABC-1');
    expect(d).toMatchObject({ description: '<h1>Hi</h1>', format: 'html', descriptionText: 'h1. Hi', comments: [{ author: 'Kim', body: '<b>raw</b>', format: 'html' }] });
    await jira.comment('ABC-1', 'Looks good');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: JSON.stringify({ body: 'Looks good' }) });
  });

  it('reports errors from the server', async () => {
    const jira = new JiraSource(config, 'tok', fakeFetch({}).fetch);
    await expect(jira.list()).rejects.toThrow(/404/);
  });
});

describe('GitHub Issues', () => {
  const config = { kind: 'github' as const, id: 'gh-1', owner: 'acme', repo: 'app' };
  const base = 'https://api.github.com/repos/acme/app';

  it('finds the repository of a remote', () => {
    expect(gitHubRepo('git@github.com:acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
    expect(gitHubRepo('https://github.com/acme/app')).toEqual({ owner: 'acme', repo: 'app' });
    expect(gitHubRepo('https://gitlab.com/acme/app.git')).toBeUndefined();
  });

  it('lists issues (not pull requests), open ones by label, closed ones as done', async () => {
    const { fetch, calls } = fakeFetch({
      [`${base}/issues?state=open`]: [
        { number: 1, title: 'Bug', state: 'open', html_url: 'u1', labels: [{ name: 'In Progress' }] },
        { number: 2, title: 'Idea', state: 'open', html_url: 'u2', labels: [] },
        { number: 3, title: 'A PR', state: 'open', html_url: 'u3', pull_request: {} },
      ],
      [`${base}/issues?state=closed`]: [{ number: 4, title: 'Old', state: 'closed', html_url: 'u4' }],
    });
    const gh = new GitHubSource(config, async () => 'tok', fetch);
    expect((await gh.list()).map((i) => [i.id, i.status])).toEqual([
      ['GH-1', 'doing'],
      ['GH-2', 'todo'],
      ['GH-4', 'done'],
    ]);
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('reads details and comments, and posts comments', async () => {
    const { fetch, calls } = fakeFetch({
      [`${base}/issues/7/comments`]: [{ user: { login: 'kim' }, created_at: '2026-10-10T10:00:00Z', body: 'Same here' }],
      [`${base}/issues/7`]: { number: 7, title: 'Crash', state: 'open', html_url: 'u7', body: 'It **crashes**' },
    });
    const gh = new GitHubSource(config, async () => 'tok', fetch);
    expect(await gh.details('GH-7')).toMatchObject({ description: 'It **crashes**', format: 'markdown', comments: [{ author: 'kim', body: 'Same here' }] });
    await gh.comment('GH-7', 'On it');
    expect(calls.at(-1)).toMatchObject({ url: `${base}/issues/7/comments`, method: 'POST' });
    await expect(gh.details('ABC-1')).rejects.toThrow(/not a GitHub issue/);
  });
});
