import { describe, expect, it } from 'vitest';
import { backlogActionKey, BusyActions, withMoves, type BacklogMessage } from '../../../src/webview/backlogActions';

const approve: BacklogMessage = { type: 'backlog', op: 'approve', id: 'BL-3' };

describe('backlog busy actions (BL-117)', () => {
  it('sets busy on click and clears it on done', () => {
    const busy = new BusyActions();
    expect(busy.start(approve)).toBe(true);
    expect(busy.has(approve)).toBe(true);
    expect(busy.onItem('BL-3')).toBe(true);
    // The host's backlogDone carries a copy of the message.
    busy.finish(structuredClone(approve));
    expect(busy.has(approve)).toBe(false);
    expect(busy.onItem('BL-3')).toBe(false);
  });

  it('clears on failed too, and takes no second click while busy', () => {
    const busy = new BusyActions();
    busy.start(approve);
    expect(busy.start(approve)).toBe(false);
    busy.finish({ ...approve }); // backlogDone with failed: true ends it the same way
    expect(busy.start(approve)).toBe(true);
  });

  it('tells actions apart by op, item and fix', () => {
    expect(backlogActionKey(approve)).not.toBe(backlogActionKey({ type: 'backlog', op: 'approve', id: 'BL-4' }));
    expect(backlogActionKey({ type: 'backlog', op: 'start', id: 'BL-3' })).not.toBe(backlogActionKey(approve));
    expect(backlogActionKey({ type: 'backlog', op: 'fix', id: 'BL-3', fix: 'resume' })).not.toBe(
      backlogActionKey({ type: 'backlog', op: 'fix', id: 'BL-3', fix: 'retry' }),
    );
    expect(backlogActionKey({ type: 'backlog', op: 'plan' })).toBe('plan:');
  });

  it('drops the actions of cards that went, keeping the title buttons', () => {
    const busy = new BusyActions();
    busy.start({ type: 'backlog', op: 'dismiss', id: 'BL-9' });
    busy.start({ type: 'backlog', op: 'plan' });
    expect(busy.prune(new Set(['BL-3']))).toBe(true);
    expect(busy.onItem('BL-9')).toBe(false);
    expect(busy.has({ type: 'backlog', op: 'plan' })).toBe(true);
    expect(busy.prune(new Set(['BL-3']))).toBe(false);
  });
});

describe('a card dropped in a lane (BL-118)', () => {
  const item = (id: string, status: 'todo' | 'doing' | 'done', proposed?: boolean) => ({ id, title: id, status, created: '', ...(proposed ? { proposed: {} } : {}) }) as never;
  const ids = (items: Array<{ id: string; status: string }>) => items.map((i) => `${i.id}:${i.status}`);

  it("shows there at once: before the card it was dropped on, else after its lane's last", () => {
    const items = [item('BL-1', 'todo'), item('BL-2', 'todo'), item('BL-3', 'doing'), item('BL-4', 'done')];
    expect(ids(withMoves(items, [{ type: 'backlog', op: 'move', id: 'BL-4', status: 'todo', before: 'BL-2' }]))).toEqual(['BL-1:todo', 'BL-4:todo', 'BL-2:todo', 'BL-3:doing']);
    expect(ids(withMoves(items, [{ type: 'backlog', op: 'move', id: 'BL-1', status: 'doing' }]))).toEqual(['BL-2:todo', 'BL-3:doing', 'BL-1:doing', 'BL-4:done']);
  });

  it('is pending until the host is done, a proposal shown accepted', () => {
    const busy = new BusyActions();
    const move: BacklogMessage = { type: 'backlog', op: 'move', id: 'BL-1', status: 'todo' };
    busy.start(move);
    busy.start({ type: 'backlog', op: 'delete', id: 'BL-2' });
    expect(busy.moves()).toEqual([move]);
    const [moved] = withMoves([item('BL-1', 'todo', true)], busy.moves()) as Array<{ proposed?: unknown }>;
    expect(moved.proposed).toBeUndefined();
    busy.finish(move);
    expect(busy.moves()).toEqual([]);
  });
});
