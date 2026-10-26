import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { startFakeGitHub, type FakeGitHub } from '../../../../scripts/fake-github.mjs';
import type { Fetch } from '../../../../src/features/backlog/sources/source';
import {
  ensurePullRequest,
  GitHubPullRequests,
  pullRequestBody,
  settleMerged,
} from '../../../../src/features/ci/pullRequests';
import { git, initRepo, removeDir } from '../../../helpers/gitRepo';

let fake: FakeGitHub | undefined;
const cleanup: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  cleanup.splice(0).forEach(removeDir);
});

const client = async (repoDir?: string) => {
  fake = await startFakeGitHub({ port: 0, repoDir });
  return new GitHubPullRequests('playground', 'app', async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url);
};
const open = { branch: 'feature/BL-1-x', base: 'main', title: 'X', body: 'Does X.\n\nFlotilla ticket BL-1.' };

describe("a ticket's pull request", () => {
  it('is created for a branch without one, and reused while it is open', async () => {
    const prs = await client();
    const first = await ensurePullRequest(prs, open);
    expect(first).toEqual({ created: true, pr: { branch: open.branch, number: 1, url: 'https://github.com/playground/app/pull/1', state: 'open' } });
    expect(await ensurePullRequest(prs, open)).toEqual({ created: false, pr: first.pr });
    expect(fake!.pulls()).toHaveLength(1);
    expect(fake!.pulls()[0]).toMatchObject({ head: open.branch, base: 'main', title: 'X', body: open.body });
  });

  it('is created again once the one there was is closed', async () => {
    const prs = await client();
    const { pr } = await ensurePullRequest(prs, open);
    expect(await prs.close(pr.number, 'Not this one.')).toMatchObject({ number: 1, state: 'closed' });
    expect(fake!.pulls()[0].comments).toEqual(['Not this one.']);
    expect(await ensurePullRequest(prs, open)).toMatchObject({ created: true, pr: { number: 2, state: 'open' } });
  });

  it("isn't reused for another branch", async () => {
    const prs = await client();
    await ensurePullRequest(prs, open);
    expect(await ensurePullRequest(prs, { ...open, branch: 'feature/BL-2-y' })).toMatchObject({ created: true, pr: { number: 2 } });
  });

  it("says when GitHub refuses it (the branch isn't there)", async () => {
    const dir = initRepo();
    cleanup.push(dir);
    const prs = await client(dir);
    await expect(ensurePullRequest(prs, open)).rejects.toThrow(/^422/);
  });

  it("has the ticket's When it's done lines and its id as its body", () => {
    expect(pullRequestBody('BL-1', 'X', 'It does X.')).toBe('It does X.\n\nFlotilla ticket BL-1.');
    expect(pullRequestBody('BL-1', 'X', undefined)).toBe('X\n\nFlotilla ticket BL-1.');
  });
});

describe('a merged ticket’s pull request', () => {
  /** A repository whose origin's main is at main, and the ticket's branch on origin too. */
  const repo = () => {
    const dir = initRepo();
    cleanup.push(dir);
    git(dir, 'checkout', '-q', '-b', open.branch);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'BL-1: X');
    git(dir, 'update-ref', `refs/remotes/origin/${open.branch}`, open.branch);
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    return dir;
  };

  it("is left open while main isn't on origin with the commit that landed", async () => {
    const prs = await client(repo());
    const { pr } = await ensurePullRequest(prs, open);
    const landed = { commit: 'abc1234', base: 'main', onOrigin: false, headOnOrigin: false };
    expect(await settleMerged(prs, pr, landed)).toEqual(pr);
    expect(fake!.pulls()[0].state).toBe('open');
  });

  it('shows as merged once origin’s main has its commits (main fast-forwarded to them)', async () => {
    const dir = repo();
    const prs = await client(dir);
    const { pr } = await ensurePullRequest(prs, open);
    git(dir, 'update-ref', 'refs/remotes/origin/main', open.branch);
    const tip = git(dir, 'rev-parse', open.branch);
    expect(await settleMerged(prs, pr, { commit: tip, base: 'main', onOrigin: true, headOnOrigin: true })).toMatchObject({ state: 'merged' });
    expect(fake!.pulls()[0].comments).toEqual([]);
  });

  it('is closed, with a comment naming the commit that landed, when other commits did', async () => {
    const prs = await client(repo());
    const { pr } = await ensurePullRequest(prs, open);
    const closed = await settleMerged(prs, pr, { commit: 'abc1234def', base: 'main', onOrigin: true, headOnOrigin: false });
    expect(closed).toMatchObject({ number: 1, state: 'closed' });
    expect(fake!.pulls()[0].comments).toEqual([expect.stringContaining('abc1234def')]);
  });
});
