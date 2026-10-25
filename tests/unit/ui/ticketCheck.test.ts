import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import type { TicketEntry } from '../../../src/features/backlog/ticket';
import { STUCK_MS, type ProcessInfo } from '../../../src/features/backlog/ticketCheck';
import { transcriptPath } from '../../../src/features/chats/chats';
import { TicketChecker } from '../../../src/ui/backlog/ticketCheck';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
} from '../../helpers/gitRepo';

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

const creating = () => path.join(root, 'repo', '.git', 'flotilla', 'creating');
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

function checker(
  o: { item?: Partial<BacklogItem>; ps?: ProcessInfo[]; here?: boolean; alive?: boolean; data?: Partial<BacklogData>; mainRoot?: string; busy?: boolean } = {},
) {
  const item = { id: 'BL-1', title: 'One', status: 'doing', priority: 'medium', branch: 'feature/BL-1-one', ...o.item } as BacklogItem;
  const data = { items: [item, { id: 'BL-2', title: 'Two', status: 'todo', priority: 'medium' } as BacklogItem], ...o.data } as BacklogData;
  const reviews = { runsAgentOf: vi.fn(() => false), stopForCheck: vi.fn(async () => true), clearWorktreeForCheck: vi.fn(async () => true) };
  const merger = { runsMergeOf: vi.fn(() => false), forCheck: vi.fn(async () => true), rebuildQueue: vi.fn(async () => true), busy: vi.fn(() => !!o.busy) };
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
    mainRoot: o.mainRoot,
    tmpdir: path.join(root, 'tmp'),
    now: () => now,
    creating: { dir: creating(), host: 'box', alive: () => !!o.alive },
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

  it('clears a review naming a worktree that is gone (BL-167)', async () => {
    const { c, reviews } = checker({ item: { review: { state: 'approved', worktree: '/gone/.git/worktrees/x' } as BacklogItem['review'] } });
    const [claim] = await c.check('BL-1');
    expect(claim).toMatchObject({ key: 'worktree:review', ok: false });
    expect(await c.cleanUp('BL-1', { confirm: yes })).toEqual([expect.stringContaining('was gone; cleared it')]);
    expect(reviews.clearWorktreeForCheck).toHaveBeenCalledWith('BL-1', '/gone/.git/worktrees/x');
  });

  it('leaves a review whose worktree is there, on the ticket’s branch', async () => {
    const { c } = checker({ item: { review: { state: 'approved', worktree: gitDir } as BacklogItem['review'] } });
    expect(await c.check('BL-1')).toEqual([expect.objectContaining({ key: 'worktree:review', ok: true })]);
  });

  it('clears "Creating its worktree…" when its window is gone, and leaves it while that runs (BL-167)', async () => {
    fs.mkdirSync(creating(), { recursive: true });
    const file = path.join(creating(), 'BL-1.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'BL-1', pid: 4812, host: 'box', at: now.getTime() - 5_000 }));

    expect(await checker({ alive: true }).c.check('BL-1')).toEqual([expect.objectContaining({ key: 'creating:BL-1', ok: true })]);
    expect(await checker({ alive: true }).c.cleanUp('BL-1', { confirm: yes })).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);

    const { c } = checker({ alive: false });
    expect((await c.check('BL-1'))[0]).toMatchObject({ key: 'creating:BL-1', ok: false });
    await c.cleanUp('BL-1', { confirm: yes });
    expect(fs.existsSync(file)).toBe(false);
    expect(notes[0].body).toContain('process 4812) was gone');
  });
});

describe('Check of the merge queue and train, and orphaned merge worktrees (BL-166)', () => {
  const approved = { status: 'review', review: { round: 1, state: 'approved' } } as Partial<BacklogItem>;
  let repo: string;
  let tip: string;
  beforeEach(() => {
    repo = initRepo(path.join(root, 'repo-main'));
    git(repo, 'branch', 'feature/BL-1-one');
    tip = git(repo, 'rev-parse', 'feature/BL-1-one');
  });
  const train = (entries: Array<{ id: string; tip?: string }>) => ({
    base: 'main',
    baseTip: tip,
    tip,
    built: now.toISOString(),
    entries: entries.map((e) => ({ id: e.id, branch: 'feature/BL-1-one', tip: e.tip ?? tip, commit: tip })),
  });

  it("leaves a queued ticket whose train entry is on its branch's tip alone", async () => {
    const { c } = checker({ item: approved, mainRoot: repo, data: { mergeQueue: ['BL-1'], mergeTrain: train([{ id: 'BL-1' }]) } });
    const claims = await c.check('BL-1');
    expect(claims).toEqual([expect.objectContaining({ key: 'queue', ok: true, text: expect.stringContaining('1st of 1 in the merge queue') })]);
  });

  it('finds a train entry whose branch moved: Clean Up rebuilds the queue and train, and notes it', async () => {
    const { c, merger } = checker({ item: approved, mainRoot: repo, data: { mergeQueue: ['BL-1'], mergeTrain: train([{ id: 'BL-1' }]) } });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
    git(repo, 'branch', '-f', 'feature/BL-1-one', 'HEAD');
    const [claim] = await c.check('BL-1');
    expect(claim).toMatchObject({ key: 'queue', ok: false, text: expect.stringContaining(`at ${tip.slice(0, 7)}, but it's at`) });
    expect(merger.rebuildQueue).not.toHaveBeenCalled(); // nothing changes on a check
    expect(await c.cleanUp('BL-1', { confirm: yes })).toHaveLength(1);
    expect(merger.rebuildQueue).toHaveBeenCalledTimes(1);
    expect(notes[0].body).toContain('rebuilt the merge queue and train');
  });

  it('finds a train entry whose branch is gone', async () => {
    git(repo, 'branch', '-D', 'feature/BL-1-one');
    const { c } = checker({ item: approved, mainRoot: repo, data: { mergeQueue: ['BL-1'], mergeTrain: train([{ id: 'BL-1' }]) } });
    expect((await c.check('BL-1'))[0]).toMatchObject({ ok: false, text: expect.stringContaining('the branch is gone') });
  });

  it('finds a done ticket still queued, in Check All too', async () => {
    const { c } = checker({ item: { status: 'done' }, mainRoot: repo, data: { mergeQueue: ['BL-1'] } });
    expect((await c.check('BL-1'))[0]).toMatchObject({ key: 'queue', ok: false, text: "BL-1 is in the merge queue, but it's done" });
    expect([...(await c.checkAll()).keys()]).toEqual(['BL-1']);
  });

  it('keeps the place of a ticket whose train conflict is being resolved', async () => {
    const merging = {
      dir: path.join(root, 'nowhere'),
      branch: 'feature/BL-1-one',
      base: 'main',
      baseTip: tip,
      state: 'resolving',
      started: now.toISOString(),
      train: { ahead: [] },
    };
    const { c } = checker({ item: { ...approved, merging } as Partial<BacklogItem>, mainRoot: repo, data: { mergeQueue: ['BL-1'] } });
    expect((await c.check('BL-1')).find((x) => x.key === 'queue')).toMatchObject({ ok: true });
  });

  it("finds queue and train entries of tickets that don't exist: Clean Up All rebuilds once", async () => {
    const { c, merger } = checker({ mainRoot: repo, data: { mergeQueue: ['BL-7', 'BL-8'], mergeTrain: train([{ id: 'BL-7' }]) } });
    const found = await c.checkRepo();
    expect(found.map((x) => x.key)).toEqual(['queue:BL-7', 'queue:BL-8']);
    expect(await c.cleanUpRepo({ confirm: yes })).toHaveLength(2);
    expect(merger.rebuildQueue).toHaveBeenCalledTimes(1);
  });

  describe('orphaned merge worktrees', () => {
    const mergeDir = (name: string) => path.join(root, 'tmp', 'flotilla-merge', name);
    const add = (name: string, age: number) => {
      const dir = mergeDir(name);
      git(repo, 'worktree', 'add', '-q', '--detach', dir, 'main');
      fs.utimesSync(dir, ago(age), ago(age));
      return dir;
    };
    const H = 60 * 60_000;

    it('finds old ones no merge names, and Clean Up removes them, asking first for one with uncommitted changes', async () => {
      const orphan = add('repo-BL-9-aaaa', 2 * H);
      const dirty = add('repo-BL-10-bbbb', 2 * H);
      fs.writeFileSync(path.join(dirty, 'README.md'), 'changed\n');
      fs.utimesSync(dirty, ago(2 * H), ago(2 * H));
      const named = add('repo-BL-1-cccc', 2 * H);
      const fresh = add('repo-BL-11-dddd', 60_000);
      const foreign = mergeDir('other-BL-3-eeee'); // another repository's: not in this one's worktree list
      fs.mkdirSync(foreign, { recursive: true });
      fs.utimesSync(foreign, ago(2 * H), ago(2 * H));
      const merging = { dir: named, branch: 'feature/BL-1-one', base: 'main', baseTip: tip, state: 'failed', started: now.toISOString() };
      const { c } = checker({ item: { merging } as Partial<BacklogItem>, mainRoot: repo });

      const found = await c.checkRepo();
      expect(found.map((x) => x.key).sort()).toEqual([`orphan:${dirty}`, `orphan:${orphan}`].sort());
      expect(found.find((x) => x.key === `orphan:${dirty}`)?.ask).toContain('uncommitted changes');
      expect(found.find((x) => x.key === `orphan:${orphan}`)?.ask).toBeUndefined();

      const asked: string[] = [];
      await c.cleanUpRepo({ confirm: async (q) => (asked.push(q), false) });
      expect(asked).toHaveLength(1);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.existsSync(dirty)).toBe(true);
      await c.cleanUpRepo({ confirm: yes });
      expect(fs.existsSync(dirty)).toBe(false);
      for (const kept of [named, fresh, foreign]) expect(fs.existsSync(kept)).toBe(true);
      expect(git(repo, 'worktree', 'list')).not.toContain('repo-BL-9-aaaa');
    });

    it('looks for none while this window runs a merge', async () => {
      add('repo-BL-9-aaaa', 2 * H);
      expect(await checker({ mainRoot: repo, busy: true }).c.checkRepo()).toEqual([]);
    });
  });
});
