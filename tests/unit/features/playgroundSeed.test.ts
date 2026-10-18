import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedPlayground } from '../../../scripts/playground-seed.mjs';
import { childrenOf, ID_PATTERN } from '../../../src/features/backlog/backlog';
import { descriptionHash } from '../../../src/features/backlog/changes';
import { LocalBacklog } from '../../../src/features/backlog/localBacklog';
import { fixesFor, readyReport, userAnswer, verdictReport } from '../../../src/features/backlog/review';
import { latestRun, placedRunBlocks } from '../../../src/features/backlog/runBlocks';
import type { TicketEntry } from '../../../src/features/backlog/ticket';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const now = new Date('2026-10-12T18:00:00');

/** The playground as playground.mjs makes it: a repo on main with its first commit, seeded. */
function seeded(): { dir: string; backlog: LocalBacklog } {
  const dir = initRepo();
  cleanup.push(dir);
  expect(seedPlayground(dir, now)).toBe(true);
  return { dir, backlog: new LocalBacklog(dir, path.join(dir, '.git')) };
}

/** Each ticket's status and review state, as the scenarios intend them. */
const STATES: Record<string, [status: string, review?: string]> = {
  'BL-1': ['review', 'yours'],
  'BL-2': ['review', 'yours'],
  'BL-3': ['doing', 'asking'],
  'BL-4': ['todo'],
  'BL-5': ['todo'],
  'BL-6': ['doing'],
  'BL-7': ['done'],
  'BL-8': ['todo'],
  'BL-9': ['done'],
  'BL-10': ['review', 'approved'],
  'BL-11': ['review', 'stopped'],
  'BL-12': ['review', 'paused'],
  'BL-13': ['review', 'approved'],
};

/** Each branch's commits ahead of main and behind it, and the status of its worktree, by ticket. */
const BRANCHES: Record<string, { ahead: number; behind: number; status: string[] }> = {
  'BL-1': { ahead: 2, behind: 0, status: [] },
  'BL-2': { ahead: 1, behind: 1, status: [] },
  'BL-3': { ahead: 2, behind: 0, status: ['A  src/chat-store.js', ' M src/chats.js', '?? notes.txt'] },
  'BL-10': { ahead: 1, behind: 0, status: [] },
  'BL-11': { ahead: 1, behind: 0, status: ['?? scratch.txt'] },
  'BL-12': { ahead: 1, behind: 0, status: [] },
  'BL-13': { ahead: 1, behind: 0, status: [] },
};

describe('playground seed', () => {
  it('loads a backlog with every ticket in its state', async () => {
    const { backlog } = seeded();
    const data = await backlog.read();
    expect(data.items.map((i) => i.id)).toEqual(Object.keys(STATES));
    expect(data.counters).toEqual({ BL: 13 });
    for (const item of data.items) {
      const [status, review] = STATES[item.id];
      expect(ID_PATTERN.test(item.id), item.id).toBe(true);
      expect(item.status, item.id).toBe(status);
      expect(item.review?.state, item.id).toBe(review);
      const ticket = await backlog.readTicket(item);
      expect(ticket.title, item.id).toBe(item.title);
      expect(descriptionHash(ticket.description), item.id).toBe(item.descriptionHash);
    }
  });

  it('has one proposed ticket, one accepted, and an epic with its parts', async () => {
    const { backlog } = seeded();
    const data = await backlog.read();
    expect(data.items.filter((i) => i.proposed).map((i) => i.id)).toEqual(['BL-4']);
    const accepted = await backlog.readTicket(data.items.find((i) => i.id === 'BL-5')!);
    expect(accepted.activity.map((e) => e.body)).toContain('You accepted it into the backlog.');
    expect(childrenOf(data, 'BL-6').map((i) => i.id)).toEqual(['BL-7', 'BL-8']);
  });

  it('has every report the review loop acts on handled, so nothing starts when the playground opens', async () => {
    const { backlog } = seeded();
    for (const item of (await backlog.read()).items) {
      const ticket = await backlog.readTicket(item);
      const key = (e: TicketEntry) => LocalBacklog.entryKey(item.id, e);
      expect(readyReport(ticket.activity, item.review, key), item.id).toBeUndefined();
      if (item.review) expect(verdictReport(ticket.activity, item.review, key), item.id).toBeUndefined();
    }
  });

  it('has the agent asking a question, and nothing for the user to answer yet', async () => {
    const { backlog } = seeded();
    const item = (await backlog.read()).items.find((i) => i.id === 'BL-3')!;
    const ticket = await backlog.readTicket(item);
    expect(ticket.activity.at(-1)?.body.endsWith('Waiting for you.')).toBe(true);
    expect(userAnswer(ticket.activity, item.review!, (e) => LocalBacklog.entryKey(item.id, e))).toEqual([]);
  });

  it('gives In Review tickets run blocks of each kind, one with several and one with none', async () => {
    const { backlog } = seeded();
    const runs = async (id: string) => {
      const item = (await backlog.read()).items.find((i) => i.id === id)!;
      const ticket = await backlog.readTicket(item);
      const key = (e: TicketEntry) => LocalBacklog.entryKey(id, e);
      return { blocks: placedRunBlocks(ticket.activity, key).map((p) => p.block), latest: latestRun(ticket.activity, key) };
    };
    const several = await runs('BL-1');
    expect(several.blocks.map((b) => b.kind)).toEqual(['shell', 'launch', 'task', 'open', 'open']);
    // An open block's title is its target: the URL, or the file in the worktree.
    expect(several.blocks.map((b) => b.title)).toEqual(['Check the card', 'Run App', 'test', 'http://127.0.0.1:5173', 'src/card.js']);
    expect(several.latest?.kind).toBe('open');
    expect((await runs('BL-2')).blocks).toEqual([]);
    expect((await runs('BL-10')).blocks.map((b) => b.kind)).toEqual(['shell']);
  });

  it('stops a review with the fixes for why it stopped, and pauses one on a limit that does not reset soon', async () => {
    const { backlog } = seeded();
    const data = await backlog.read();
    const stopped = data.items.find((i) => i.id === 'BL-11')!.review!;
    expect(fixesFor(stopped.stop?.kind, !!stopped.stop?.task)).toEqual(['retry', 'newAgent']);
    const paused = data.items.find((i) => i.id === 'BL-12')!.review!;
    expect(paused.paused).toMatchObject({ known: true, phase: 'review', resume: 'reviewing' });
    expect(Date.parse(paused.paused!.until!)).toBeGreaterThan(Date.now());
  });

  it('has a worktree for each ticket with a branch, ahead, behind or with changes as its ticket needs', async () => {
    const { dir, backlog } = seeded();
    const data = await backlog.read();
    // Porcelain: a "worktree <path>" line, then its "branch refs/heads/<name>" line.
    const worktrees = new Map<string, string>();
    let folder = '';
    for (const line of git(dir, 'worktree', 'list', '--porcelain').split('\n')) {
      if (line.startsWith('worktree ')) folder = line.slice('worktree '.length);
      const branch = /^branch refs\/heads\/(.+)$/.exec(line)?.[1];
      if (branch) worktrees.set(branch, folder);
    }
    for (const item of data.items) {
      if (!item.branches) continue;
      const [branch] = item.branches;
      const want = BRANCHES[item.id];
      expect(want, item.id).toBeDefined();
      expect(worktrees.has(branch), item.id).toBe(true);
      expect(git(dir, 'rev-list', '--count', `main..${branch}`), item.id).toBe(String(want.ahead));
      expect(git(dir, 'rev-list', '--count', `${branch}..main`), item.id).toBe(String(want.behind));
      const status = git(worktrees.get(branch)!, 'status', '--porcelain').split('\n').filter(Boolean);
      expect(status, item.id).toEqual(want.status);
    }
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('does nothing when the playground is seeded already', async () => {
    const { dir, backlog } = seeded();
    const before = await backlog.read();
    expect(seedPlayground(dir, new Date('2030-01-01T00:00:00'))).toBe(false);
    expect(await backlog.read()).toEqual(before);
  });
});
