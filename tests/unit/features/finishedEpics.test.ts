import { describe, expect, it } from 'vitest';
import {
  type BacklogData,
  type BacklogItem,
  type BacklogStatus,
  closeFinishedEpics,
} from '../../../src/features/backlog/backlog';

const created = '2026-10-26T06:00:00Z';
const item = (id: string, status: BacklogStatus, extra: Partial<BacklogItem> = {}): BacklogItem => ({ id, title: id, status, created, ...extra });
const data = (...items: BacklogItem[]): BacklogData => ({ version: 1, next: 300, items });
const statuses = (d: BacklogData) => Object.fromEntries(d.items.map((i) => [i.id, `${i.status}${i.keptOpen ? ' (kept open)' : ''}`]));
const setStatus = (d: BacklogData, id: string, status: BacklogStatus) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, status } : i)) });

describe('finished epics (BL-206)', () => {
  it('moves an epic whose parts are all done already to Done (BL-125 and BL-156)', () => {
    const d = data(item('BL-125', 'todo'), item('BL-126', 'done', { parent: 'BL-125' }), item('BL-127', 'done', { parent: 'BL-125' }), item('BL-9', 'todo'));
    const { data: next, closed } = closeFinishedEpics(d, d);
    expect(closed).toEqual([{ id: 'BL-125', parts: ['BL-126', 'BL-127'] }]);
    expect(statuses(next)).toEqual({ 'BL-125': 'done', 'BL-126': 'done', 'BL-127': 'done', 'BL-9': 'todo' });
  });

  it('moves it when its last part gets to Done, however it got there', () => {
    const before = data(item('BL-1', 'doing'), item('BL-2', 'done', { parent: 'BL-1' }), item('BL-3', 'review', { parent: 'BL-1' }));
    const { data: next, closed } = closeFinishedEpics(before, setStatus(before, 'BL-3', 'done'));
    expect(closed.map((c) => c.id)).toEqual(['BL-1']);
    expect(next.items[0].status).toBe('done');
  });

  it('keeps an epic with a part not done, or with an open proposal among its parts', () => {
    const notDone = data(item('BL-1', 'todo'), item('BL-2', 'done', { parent: 'BL-1' }), item('BL-3', 'review', { parent: 'BL-1' }));
    expect(closeFinishedEpics(notDone, notDone).closed).toEqual([]);
    const proposal = data(item('BL-1', 'todo'), item('BL-2', 'done', { parent: 'BL-1' }), item('BL-3', 'done', { parent: 'BL-1', proposed: {} }));
    expect(closeFinishedEpics(proposal, proposal).closed).toEqual([]);
    // Dismissed: the proposal is gone, and doesn't hold it.
    const dismissed = { ...proposal, items: proposal.items.filter((i) => i.id !== 'BL-3') };
    expect(closeFinishedEpics(proposal, dismissed).closed.map((c) => c.id)).toEqual(['BL-1']);
  });

  it('leaves items without parts, and proposed epics, where they are', () => {
    const d = data(item('BL-1', 'todo'), item('BL-2', 'todo', { proposed: { by: 'Nova-7' } }), item('BL-3', 'done', { parent: 'BL-2' }));
    expect(closeFinishedEpics(d, d).closed).toEqual([]);
  });

  it('keeps an epic you move out of Done there until another of its parts finishes', () => {
    const done = data(item('BL-1', 'done'), item('BL-2', 'done', { parent: 'BL-1' }));
    let { data: next } = closeFinishedEpics(done, setStatus(done, 'BL-1', 'todo'));
    expect(statuses(next)).toEqual({ 'BL-1': 'todo (kept open)', 'BL-2': 'done' });
    // Later changes (and the sweep) leave it.
    expect(closeFinishedEpics(next, next).closed).toEqual([]);
    // A new part, then done: it moves.
    const added = { ...next, items: [...next.items, item('BL-3', 'doing', { parent: 'BL-1' })] };
    ({ data: next } = closeFinishedEpics(next, added));
    expect(statuses(next)['BL-1']).toBe('todo (kept open)');
    ({ data: next } = closeFinishedEpics(next, setStatus(next, 'BL-3', 'done')));
    expect(statuses(next)['BL-1']).toBe('done');
  });

  it('closes epics of epics in turn', () => {
    const before = data(item('BL-1', 'todo'), item('BL-2', 'todo', { parent: 'BL-1' }), item('BL-3', 'review', { parent: 'BL-2' }));
    const { data: next, closed } = closeFinishedEpics(before, setStatus(before, 'BL-3', 'done'));
    expect(closed).toEqual([
      { id: 'BL-2', parts: ['BL-3'] },
      { id: 'BL-1', parts: ['BL-2'] },
    ]);
    expect(statuses(next)).toEqual({ 'BL-1': 'done', 'BL-2': 'done', 'BL-3': 'done' });
  });

  it("notes it in the epic's activity, as done by Flotilla, when the store writes the last part", async () => {
    const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
    const { makeTempDir, removeDir } = await import('../../helpers/gitRepo');
    const root = makeTempDir();
    try {
      const store = new LocalBacklog(root, `${root}/.git`);
      await store.change(() => data(item('BL-1', 'todo'), item('BL-2', 'done', { parent: 'BL-1' }), item('BL-3', 'review', { parent: 'BL-1' })));
      await store.change((d) => setStatus(d, 'BL-3', 'done'));
      expect(statuses(await store.read())['BL-1']).toBe('done');
      const ticket = await store.readTicket(item('BL-1', 'done'));
      expect(ticket.activity.map((e) => [e.author, e.body])).toEqual([
        ['Flotilla', 'All its parts are done: BL-2, BL-3. Moved it from **To Do** to **Done**.'],
      ]);
      expect((await store.readTicket(item('BL-3', 'done'))).activity.map((e) => e.body)).toEqual(['You moved it from **In Review** to **Done**.']);
    } finally {
      removeDir(root);
    }
  });

  it('sweeps epics finished already, writing nothing otherwise', async () => {
    const fs = await import('node:fs');
    const { LocalBacklog } = await import('../../../src/features/backlog/localBacklog');
    const { makeTempDir, removeDir } = await import('../../helpers/gitRepo');
    const root = makeTempDir();
    try {
      const store = new LocalBacklog(root, `${root}/.git`);
      fs.mkdirSync(store.dir, { recursive: true });
      fs.writeFileSync(store.file, JSON.stringify(data(item('BL-1', 'todo'), item('BL-2', 'todo', { parent: 'BL-1' }))));
      await store.closeFinishedEpics();
      expect(fs.readFileSync(store.file, 'utf8')).not.toContain('\n');
      fs.writeFileSync(store.file, JSON.stringify(data(item('BL-1', 'todo'), item('BL-2', 'done', { parent: 'BL-1' }))));
      await store.closeFinishedEpics();
      expect(statuses(await store.read())['BL-1']).toBe('done');
    } finally {
      removeDir(root);
    }
  });
});
