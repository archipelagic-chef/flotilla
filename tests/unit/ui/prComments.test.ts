import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
}));

import { startFakeGitHub, type FakeGitHub } from '../../../scripts/fake-github.mjs';
import { addBranch, addItem } from '../../../src/features/backlog/backlog';
import { deleteEntry, editEntry } from '../../../src/features/backlog/commentEdits';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { userAnswer } from '../../../src/features/backlog/review';
import type { Fetch } from '../../../src/features/backlog/sources/source';
import { entryAnchors, entryThreads, type TicketEntry } from '../../../src/features/backlog/ticket';
import {
  commentEntries,
  markOf,
  planPosts,
  postedText,
} from '../../../src/features/ci/prComments';
import { GitHubPullRequests } from '../../../src/features/ci/pullRequests';
import { PullRequestComments } from '../../../src/ui/backlog/prComments';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const BRANCH = 'feature/BL-1-x';

describe("a ticket's comments and its pull request's", () => {
  let repo: string;
  let store: LocalBacklog;
  let fake: FakeGitHub;
  let sync: PullRequestComments;

  beforeEach(async () => {
    repo = initRepo();
    cleanup.push(repo);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/playground/app.git');
    fake = await startFakeGitHub({ port: 0 });
    const make = (owner: string, name: string) => new GitHubPullRequests(owner, name, async () => 'fake-token', globalThis.fetch as unknown as Fetch, fake.url);
    const pr = await make('playground', 'app').create({ branch: BRANCH, base: 'main', title: 'X', body: 'Does X.' });
    store = new LocalBacklog(repo, path.join(repo, '.git'));
    await store.change((d) => {
      const data = addBranch(addItem(d, 'X', 'BL', new Date()).data, 'BL-1', BRANCH);
      return { ...data, items: data.items.map((i) => ({ ...i, status: 'review' as const, pullRequests: [pr] })) };
    });
    sync = new PullRequestComments({
      backlog: store,
      mainRoot: repo,
      isLeader: () => true,
      output: { appendLine: () => undefined } as never,
      pullRequests: make,
      shown: () => [],
      shownMs: 3_600_000,
      changedMs: 3_600_000,
    });
  });

  afterEach(async () => {
    sync.dispose();
    await fake.close();
  });

  const item = async () => (await store.read()).items[0];
  const activity = async () => (await store.readTicket(await item())).activity;
  const comment = async (author: string, body: string) => store.appendActivity(await item(), { date: '2026-10-26 10:00', author, body });
  const onGitHub = () => fake.pulls()[0].allComments;

  it("brings the pull request's comments in once each, and posts your comments and reports' summaries once each", async () => {
    await comment('You', 'Before the pull request: not posted.');
    fake.comment({ login: 'octocat', body: 'Looks good, but the greeting is long.' });
    await sync.sync();
    expect(onGitHub()).toHaveLength(1);
    let entries = await activity();
    expect(entries.at(-1)).toMatchObject({ author: 'octocat on GitHub' });
    expect(entries.at(-1)!.body).toContain('Looks good, but the greeting is long.');
    expect(entries.at(-1)!.body).toMatch(/\[On GitHub\]\(https:\/\/github\.com\/playground\/app\/pull\/1#issuecomment-\d+\)/);

    await comment('You', 'I agree: shorter.');
    await comment('Agent Nova-7', 'Shortened the greeting.\nNeeds from you: nothing\n\n#### How to review\nThe details.');
    await comment('Flotilla', 'A status line: stays in the ticket.');
    await sync.sync();
    await sync.sync();
    const posted = onGitHub().filter((c) => markOf(c.body));
    expect(posted.map((c) => c.body.split('\n\n')[0])).toEqual(['I agree: shorter.', '**Agent Nova-7**:']);
    expect(posted[1].body).toContain('Shortened the greeting.');
    expect(posted[1].body).not.toContain('The details.');
    expect(posted[0].body).toContain('vscode://archipelagic.flotilla/ticket?id=BL-1&entry=');
    // Nothing came back, nothing went twice.
    entries = await activity();
    expect(entries.filter((e) => e.author.endsWith('on GitHub'))).toHaveLength(1);
    expect(onGitHub()).toHaveLength(3);
  });

  it('keeps line comments and their threads, both ways', async () => {
    await sync.sync();
    const line = fake.comment({ login: 'octocat', body: 'Why this name?', path: 'src/greet.ts', line: 3 });
    await sync.sync();
    const entries = await activity();
    expect(entries.at(-1)!.body).toContain('**On [src/greet.ts:3](src/greet.ts#L3)**:');
    // Your reply to it goes into its thread.
    const anchor = entryAnchors(entries).at(-1)!;
    await comment('You', `↩ [Reply to octocat on GitHub, ${entries.at(-1)!.date}](#${anchor})\nIt says what it does.`);
    await sync.sync();
    const reply = onGitHub().find((c) => markOf(c.body))!;
    expect(reply).toMatchObject({ kind: 'review', inReplyTo: line });
    expect(reply.body).toContain('It says what it does.');
    // A reply on GitHub to that one is a reply in the ticket.
    fake.comment({ login: 'octocat', body: 'Fair.', inReplyTo: reply.id });
    await sync.sync();
    const all = await activity();
    const threads = entryThreads(all);
    expect(all.at(-1)!.body).toContain('Fair.');
    expect(threads.at(-1)!.reply?.to).toBe(entryAnchors(all).at(-2));
  });

  it("shows a quote reply on GitHub to a ticket's comment as a reply to it", async () => {
    await sync.sync();
    await comment('You', 'Shall we rename it?');
    await sync.sync();
    fake.comment({ login: 'octocat', body: '> Shall we rename it?\n\nYes, please.' });
    await sync.sync();
    const all = await activity();
    expect(entryThreads(all).at(-1)!.reply?.to).toBe(entryAnchors(all).at(-2));
    expect(all.at(-1)!.body).not.toContain('> Shall');
  });

  it('edits and deletes the copy on GitHub when you edit or delete your comment', async () => {
    await sync.sync();
    await comment('You', 'First version.');
    await sync.sync();
    const anchor = entryAnchors(await activity()).at(-1)!;
    await store.editTicket(await item(), (t) => ({ ...t, activity: editEntry(t.activity, anchor, 'Second version.', '2026-10-26 10:05')! }));
    await sync.sync();
    expect(onGitHub()).toHaveLength(1);
    expect(onGitHub()[0].body).toContain('Second version.');
    await store.editTicket(await item(), (t) => ({ ...t, activity: deleteEntry(t.activity, anchor, '2026-10-26 10:06')! }));
    await sync.sync();
    expect(onGitHub()).toHaveLength(0);
    // Not posted again.
    await sync.sync();
    expect(onGitHub()).toHaveLength(0);
  });

  it("doesn't post again a comment deleted on GitHub", async () => {
    await sync.sync();
    await comment('You', 'Posted once.');
    await sync.sync();
    const [c] = onGitHub();
    await fetch(`${fake.url}/repos/playground/app/issues/comments/${c.id}`, { method: 'DELETE' });
    await sync.sync();
    expect(onGitHub()).toHaveLength(0);
  });
});

describe('the sync, without GitHub', () => {
  const at = (author: string, body: string, date = '2026-10-26 10:00'): TicketEntry => ({ date, author, body });

  it('posts what people and agents said, not status lines nor what came from GitHub', () => {
    expect(postedText(at('You', 'Hi.'))).toBe('Hi.');
    expect(postedText(at('Agent Nova-7', 'Did it.\nNeeds from you: nothing\n\nDetails.'))).toBe('Did it.');
    expect(postedText(at('Agent Nova-7', 'An old report without a summary.'))).toBeUndefined();
    expect(postedText(at('Flotilla', 'Moved.'))).toBeUndefined();
    expect(postedText(at('octocat on GitHub', 'Hi.'))).toBeUndefined();
    expect(postedText(at('You', '_Comment deleted._\n<!-- deleted 2026-10-26 10:01 -->'))).toBeUndefined();
  });

  it('knows the entries there when the pull request is first seen without posting them', () => {
    const activity = [at('You', 'Old.')];
    expect(planPosts({ id: 'BL-1', activity, comments: [], known: undefined })).toEqual({ known: ['2026-10-26-1000-you'], posts: [], edits: [], deletes: [] });
    expect(
      planPosts({ id: 'BL-1', activity: [...activity, at('You', 'New.', '2026-10-26 10:01')], comments: [], known: ['2026-10-26-1000-you'] }).posts,
    ).toEqual([expect.objectContaining({ anchor: '2026-10-26-1001-you' })]);
  });

  it('brings a comment in once, and never one posted from a ticket', () => {
    const c = {
      id: 1,
      kind: 'issue' as const,
      login: 'octocat',
      body: 'Hi.',
      url: 'https://github.com/o/r/pull/1#issuecomment-1',
      createdAt: '2026-10-26T10:00:00Z',
    };
    const added = commentEntries([], [c]);
    expect(added).toHaveLength(1);
    expect(commentEntries(added, [c])).toEqual([]);
    expect(commentEntries([], [{ ...c, body: 'Mine.\n\n<!-- flotilla BL-1#2026-10-26-1000-you -->' }])).toEqual([]);
  });

  it('gives a comment from GitHub to the agent that asked, as yours', () => {
    const entries = [at('Agent Nova-7', 'Which name?\nNeeds from you: a name'), at('octocat on GitHub', 'greet()')];
    expect(userAnswer(entries, { round: 1, state: 'asking' } as never, (e) => e.body)).toEqual([entries[1]]);
  });
});
