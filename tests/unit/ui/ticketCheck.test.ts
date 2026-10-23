import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import type { TicketEntry } from '../../../src/features/backlog/ticket';
import { STUCK_MS, type ProcessInfo } from '../../../src/features/backlog/ticketCheck';
import { transcriptPath } from '../../../src/features/chats/chats';
import { TicketChecker } from '../../../src/ui/backlog/ticketCheck';
import { makeTempDir, removeDir } from '../../helpers/gitRepo';

const S = '2f6a1c3e-1111-4222-8333-944445555666';
const now = new Date('2026-10-21T16:16:00');
const ago = (ms: number) => new Date(now.getTime() - ms);

let root: string;
let gitDir: string;
let cwd: string;
let home: string;
let notes: TicketEntry[];

beforeEach(() => {
  root = makeTempDir();
  gitDir = path.join(root, 'repo', '.git', 'worktrees', 'bl-1');
  cwd = path.join(root, 'wt');
  home = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  notes = [];
});
afterEach(() => removeDir(root));

const recordFile = () => path.join(gitDir, 'flotilla', 'chats', `${S}.json`);
const record = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8')) as { state: string };

/** A chat record that says working, last written `msAgo`; and its transcript, as old. */
function chat(msAgo: number, state = 'working'): void {
  fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
  fs.writeFileSync(recordFile(), JSON.stringify({ sessionId: S, state, cwd, agent: 'Orbit-2', linkedBy: 'cwd', updatedAt: ago(msAgo).toISOString() }));
  const t = transcriptPath(cwd, S, home);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, `${JSON.stringify({ type: 'user', sessionId: S, message: { role: 'user', content: 'BL-1' } })}\n`);
  fs.utimesSync(t, ago(msAgo), ago(msAgo));
}

function checker(o: { item?: Partial<BacklogItem>; ps?: ProcessInfo[]; here?: boolean } = {}) {
  const item = { id: 'BL-1', title: 'One', status: 'doing', priority: 'medium', branch: 'feature/BL-1-one', ...o.item } as BacklogItem;
  const data = { items: [item, { id: 'BL-2', title: 'Two', status: 'todo', priority: 'medium' } as BacklogItem] } as BacklogData;
  const reviews = { runsAgentOf: vi.fn(() => false), stopForCheck: vi.fn(async () => true) };
  const merger = { runsMergeOf: vi.fn(() => false), forCheck: vi.fn(async () => true) };
  const kill = vi.fn();
  const c = new TicketChecker({
    backlog: { read: async () => data, appendActivity: async (_i, e) => void notes.push(e) },
    repository: { current: [{ worktree: { isMain: false, path: cwd, branch: 'feature/BL-1-one', adminDir: gitDir } }] },
    reviews,
    merger,
    runsHere: () => !!o.here,
    processes: async () => o.ps ?? [],
    kill,
    staleMinutes: 10,
    claudeHome: home,
    now: () => now,
  });
  return { c, reviews, merger, kill };
}

const yes = async () => true;
const proc = (pid: number): ProcessInfo => ({ pid, args: `/usr/bin/claude -p x --resume ${S}` });

describe("a ticket's Check (BL-163)", () => {
  it('finds a chat that says working with no process: Clean Up marks it done, keeps it, and notes it once', async () => {
    chat(6 * 60_000);
    const { c } = checker();
    const [claim] = await c.check('BL-1');
    expect(claim).toMatchObject({ ok: false, key: `chat:${S}` });
    expect(fs.existsSync(recordFile())).toBe(true);
    expect(record().state).toBe('working'); // nothing changes on a check

    const done = await c.cleanUp('BL-1', { confirm: yes });
    expect(done).toHaveLength(1);
    expect(record().state).toBe('done');
    expect(fs.existsSync(transcriptPath(cwd, S, home))).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toMatch(/^Check: Orbit-2's chat had ended at 16:10 but showed as working; marked done\.$/);
  });

  it('leaves a chat whose process runs alone', async () => {
    chat(20_000);
    const { c, kill } = checker({ ps: [proc(4812)] });
    expect((await c.check('BL-1'))[0]).toMatchObject({ ok: true, text: 'Orbit-2 is working (process 4812, last activity 20 s ago)' });
    expect(await c.cleanUp('BL-1', { confirm: yes })).toEqual([]);
    expect(record().state).toBe('working');
    expect(kill).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it('leaves a chat this window runs alone', async () => {
    chat(6 * 60_000);
    const { c } = checker({ here: true });
    expect((await c.check('BL-1'))[0].ok).toBe(true);
    expect(await c.cleanUp('BL-1', { confirm: yes })).toEqual([]);
    expect(record().state).toBe('working');
  });

  it('claims nothing for a record that shows as done already (stale), or one that says done', async () => {
    chat(11 * 60_000);
    expect(await checker().c.check('BL-1')).toEqual([]);
    chat(60_000, 'done');
    expect(await checker().c.check('BL-1')).toEqual([]);
  });

  it('stops a stuck process only once the user says so', async () => {
    chat(STUCK_MS + 60_000);
    const { c, kill } = checker({ ps: [proc(4812)] });
    expect(await c.cleanUp('BL-1', { confirm: async () => false })).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(record().state).toBe('working');

    const confirm = vi.fn(async (_question: string) => true);
    expect(await c.cleanUp('BL-1', { confirm })).toHaveLength(1);
    expect(confirm.mock.calls[0][0]).toContain('Stop its process (4812)?');
    expect(kill).toHaveBeenCalledWith(4812);
    expect(record().state).toBe('done');
  });

  it('cleans up only the glitch named', async () => {
    chat(6 * 60_000);
    const { c, reviews } = checker({ item: { review: { round: 1, reviewer: 'Orbit-2', state: 'reviewing', reviewerSession: S } } });
    const claims = await c.check('BL-1');
    expect(claims.map((x) => [x.key, x.ok])).toEqual([
      [`chat:${S}`, false],
      ['review', false],
    ]);
    await c.cleanUp('BL-1', { keys: ['review'], confirm: yes });
    expect(reviews.stopForCheck).toHaveBeenCalledWith('BL-1', 'lost', expect.stringContaining("Orbit-2 is reviewing, but it isn't running"));
    expect(record().state).toBe('working');
  });

  it('leaves a review the loop runs alone', async () => {
    const { c, reviews } = checker({ item: { review: { round: 1, reviewer: 'Orbit-2', state: 'reviewing', reviewerSession: S } } });
    reviews.runsAgentOf.mockReturnValue(true);
    expect(await c.check('BL-1')).toEqual([expect.objectContaining({ key: 'review', ok: true })]);
    await c.cleanUp('BL-1', { confirm: yes });
    expect(reviews.stopForCheck).not.toHaveBeenCalled();
  });

  it('clears a merge whose temporary worktree is gone, and stops one whose agent runs nowhere', async () => {
    const dir = path.join(root, 'merge');
    const merging = { dir, branch: 'feature/BL-1-one', base: 'main', baseTip: 'abc', state: 'resolving' as const, agent: 'Nova-1', session: S, started: '' };
    const gone = checker({ item: { merging } });
    await gone.c.cleanUp('BL-1', { confirm: yes });
    expect(gone.merger.forCheck).toHaveBeenCalledWith('BL-1', 'gone', expect.any(String));

    fs.mkdirSync(dir);
    const lost = checker({ item: { merging } });
    await lost.c.cleanUp('BL-1', { confirm: yes });
    expect(lost.merger.forCheck).toHaveBeenCalledWith('BL-1', 'lost', expect.stringContaining('Resolve with Agent again'));

    const running = checker({ item: { merging }, ps: [proc(77)] });
    await running.c.cleanUp('BL-1', { confirm: yes });
    expect(running.merger.forCheck).not.toHaveBeenCalled();
  });

  it('Check All lists only the tickets that claim something', async () => {
    chat(6 * 60_000);
    const all = await checker().c.checkAll();
    expect([...all.keys()]).toEqual(['BL-1']);
  });
});
