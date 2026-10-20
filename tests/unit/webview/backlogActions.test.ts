import { describe, expect, it } from 'vitest';
import { backlogActionKey, BusyActions, type BacklogMessage } from '../../../src/webview/backlogActions';

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
    expect(backlogActionKey({ type: 'backlog', op: 'fix', id: 'BL-3', fix: 'resume' } as BacklogMessage)).not.toBe(
      backlogActionKey({ type: 'backlog', op: 'fix', id: 'BL-3', fix: 'merge' } as BacklogMessage),
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
