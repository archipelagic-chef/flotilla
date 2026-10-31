import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  type FakeGitHub,
  startFakeGitHub,
} from '../../../../scripts/fake-github.mjs';
import type { Fetch } from '../../../../src/features/backlog/sources/source';
import {
  closeDiscarded,
  diffHunks,
  ensurePullRequest,
  GitHubPullRequests,
  postReview,
  pullRequestBody,
  type PullRequestReviewInfo,
  reviewComments,
  reviewMark,
  settleMerged,
} from '../../../../src/features/ci/pullRequests';
import {
  git,
  initRepo,
  removeDir,
} from '../../../helpers/gitRepo';

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

  it("closes a discarded ticket's, with a comment, once (BL-225)", async () => {
    const prs = await client(repo());
    const { pr } = await ensurePullRequest(prs, open);
    expect(await closeDiscarded(prs, pr, 'BL-1')).toMatchObject({ number: 1, state: 'closed' });
    expect(await closeDiscarded(prs, pr, 'BL-1')).toMatchObject({ state: 'closed' });
    expect(fake!.pulls()[0].comments).toEqual([expect.stringContaining('BL-1 was discarded')]);
  });
});

describe("a reviewer's report as a review (BL-223)", () => {
  // src/a.ts: lines 10-16 of the new side in one hunk (13 added), 40-41 in another.
  const patch = [
    '@@ -10,6 +10,7 @@ x',
    ' a',
    ' b',
    ' c',
    '+new',
    ' d',
    '-gone',
    ' e',
    ' f',
    '@@ -39,2 +40,2 @@',
    ' g',
    '+h',
    '\\ No newline at end of file',
  ].join('\n');
  const files = [{ filename: 'src/a.ts', patch }, { filename: 'img.png' }];

  it("knows a diff's lines on the new side, hunk by hunk", () => {
    expect(diffHunks(patch).map((h) => [...h])).toEqual([
      [10, 11, 12, 13, 14, 15, 16],
      [40, 41],
    ]);
    expect(diffHunks(undefined)).toEqual([]);
  });

  it('makes findings that link a line in the diff line comments, and keeps the rest in the body', () => {
    const report = [
      'Summary: mostly good.',
      'Needs from you: nothing',
      '',
      '- [src/a.ts:13](src/a.ts#L13) adds `new` without a test.',
      '  It should have one.',
      '- [src/a.ts:12](src/a.ts#L12-L14) spans lines.',
      '- [src/a.ts:30](src/a.ts#L30) is outside the diff.',
      "- [src/b.ts:1](src/b.ts#L1) is in a file it doesn't change.",
      '1. [src/a.ts:15](./src/a.ts#L15-L44) ends in another hunk.',
      'See [src/a.ts:41](src/a.ts#L41) in a paragraph.',
      '```',
      '- [src/a.ts:40](src/a.ts#L40) in a code block',
      '```',
      'Verdict: changes requested',
    ].join('\n');
    const { body, comments } = reviewComments(report, files);
    expect(comments).toEqual([
      { path: 'src/a.ts', line: 13, side: 'RIGHT', body: '[src/a.ts:13](src/a.ts#L13) adds `new` without a test.\nIt should have one.' },
      { path: 'src/a.ts', line: 14, start_line: 12, side: 'RIGHT', start_side: 'RIGHT', body: '[src/a.ts:12](src/a.ts#L12-L14) spans lines.' },
      { path: 'src/a.ts', line: 15, side: 'RIGHT', body: '[src/a.ts:15](./src/a.ts#L15-L44) ends in another hunk.' },
    ]);
    expect(body).toBe(
      [
        'Summary: mostly good.',
        'Needs from you: nothing',
        '',
        '- [src/a.ts:30](src/a.ts#L30) is outside the diff.',
        "- [src/b.ts:1](src/b.ts#L1) is in a file it doesn't change.",
        'See [src/a.ts:41](src/a.ts#L41) in a paragraph.',
        '```',
        '- [src/a.ts:40](src/a.ts#L40) in a code block',
        '```',
        'Verdict: changes requested',
      ].join('\n'),
    );
  });

  const review = { id: 'BL-1', round: 2, reviewer: 'Nova-7', report: '- [src/a.ts:13](src/a.ts#L13) needs a test.\n\nVerdict: approved' };
  const fakeClient = (o: { own?: boolean; reviews?: PullRequestReviewInfo[] } = {}) => {
    const posted: Array<{ event: string; body: string; comments: unknown[] }> = [];
    return {
      posted,
      client: {
        files: async () => files,
        reviews: async () => o.reviews ?? [],
        review: async (_n: number, r: { event: string; body: string; comments: unknown[] }) => {
          if (o.own && r.event !== 'COMMENT') throw new Error('422 Unprocessable Entity: {"errors":["Review Can not approve your own pull request"]}');
          posted.push(r);
          return { id: 7, url: 'https://github.com/o/r/pull/1#pullrequestreview-7', body: r.body };
        },
      },
    };
  };

  it("posts it with the verdict as the review's state, headed with the agent and round", async () => {
    const { client, posted } = fakeClient();
    expect(await postReview(client, 1, { ...review, verdict: 'approved' })).toMatchObject({ id: 7 });
    expect(posted).toHaveLength(1);
    expect(posted[0].event).toBe('APPROVE');
    expect(posted[0].body).toMatch(/^\*\*Review by agent Nova-7, round 2, on Flotilla ticket BL-1: approved\.\*\*\n\n_One finding is a comment/);
    expect(posted[0].body).toContain('Verdict: approved');
    expect(posted[0].body.endsWith(reviewMark('BL-1', 2))).toBe(true);
    expect(posted[0].comments).toHaveLength(1);
    await postReview(client, 1, { ...review, verdict: 'changes' });
    expect(posted[1].event).toBe('REQUEST_CHANGES');
  });

  it('posts it as a comment review saying the verdict when GitHub refuses one on your own pull request', async () => {
    const { client, posted } = fakeClient({ own: true });
    expect(await postReview(client, 1, { ...review, verdict: 'approved' })).toMatchObject({ id: 7, asComment: true });
    expect(posted.map((p) => p.event)).toEqual(['COMMENT']);
    expect(posted[0].body).toContain(': approved.**');
  });

  it("doesn't post it again when the pull request has it already", async () => {
    const there = { id: 3, url: 'u', body: `x\n\n${reviewMark('BL-1', 2)}` };
    const { client, posted } = fakeClient({ reviews: [{ id: 2, url: 'v', body: reviewMark('BL-1', 1) }, there] });
    expect(await postReview(client, 1, { ...review, verdict: 'approved' })).toEqual({ ...there, existing: true });
    expect(posted).toEqual([]);
  });
});
