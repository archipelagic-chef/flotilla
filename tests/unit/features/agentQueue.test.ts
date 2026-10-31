import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  mayStartNow,
  ordinal,
  pauseOrder,
  prioritizeAction,
  StartQueue,
  type WaitingStart,
} from '../../../src/features/backlog/agentQueue';

const wait = (id: string, kind: WaitingStart<string>['kind'], manual = false): WaitingStart<string> => ({
  id,
  kind,
  manual,
  reason: 'slot',
  since: id,
  start: `start ${id}`,
});

describe('the agent queue', () => {
  it('starts reviews and revisions first, then resumes, then new tickets; first come first served within each', () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'new'));
    q.add(wait('BL-2', 'resume'));
    q.add(wait('BL-3', 'new'));
    q.add(wait('BL-4', 'review'));
    q.add(wait('BL-5', 'resume'));
    q.add(wait('BL-6', 'review'));
    expect(q.ordered().map((w) => w.id)).toEqual(['BL-4', 'BL-6', 'BL-2', 'BL-5', 'BL-1', 'BL-3']);
  });

  it("numbers an item's place in that order, from one", () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'new'));
    q.add(wait('BL-2', 'review'));
    expect(q.place('BL-2')).toBe(1);
    expect(q.place('BL-1')).toBe(2);
    expect(q.place('BL-9')).toBeUndefined();
  });

  it('keeps one wait per item: a new wait replaces the old one and goes to the back of its kind', () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'new'));
    q.add(wait('BL-2', 'new'));
    q.add({ ...wait('BL-1', 'new'), since: 'changed' });
    expect(q.size).toBe(2);
    expect(q.ordered().map((w) => [w.id, w.since])).toEqual([
      ['BL-2', 'BL-2'],
      ['BL-1', 'changed'],
    ]);
  });

  it('forgets a removed wait', () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'review'));
    expect(q.has('BL-1')).toBe(true);
    q.remove('BL-1');
    expect(q.has('BL-1')).toBe(false);
    expect(q.size).toBe(0);
  });
});

describe('admitting a start', () => {
  const room = { running: 1, limit: 2, ahead: 0, memoryShort: false };

  it('starts an automatic start when a slot is free, nothing waits ahead of it and memory is free', () => {
    expect(mayStartNow({ manual: false, ...room })).toBe(true);
  });

  it('queues an automatic start when the limit is reached', () => {
    expect(mayStartNow({ manual: false, ...room, running: 2 })).toBe(false);
  });

  it('queues an automatic start behind a waiting one, even with a free slot', () => {
    expect(mayStartNow({ manual: false, ...room, ahead: 1 })).toBe(false);
  });

  it('queues an automatic start while memory is short', () => {
    expect(mayStartNow({ manual: false, ...room, memoryShort: true })).toBe(false);
  });

  it('starts a start the user asked for at once, whatever runs (it counts toward the limit)', () => {
    expect(mayStartNow({ manual: true, ...room, running: 5, ahead: 3 })).toBe(true);
  });
});

describe('replies, and what waits first', () => {
  it("puts the user's replies before reviews, resumes and new tickets, first come first served within", () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'new'));
    q.add(wait('BL-2', 'review'));
    q.add(wait('BL-3', 'reply'));
    q.add(wait('BL-4', 'resume'));
    q.add(wait('BL-5', 'reply'));
    expect(q.ordered().map((w) => w.id)).toEqual(['BL-3', 'BL-5', 'BL-2', 'BL-4', 'BL-1']);
    expect(q.place('BL-5')).toBe(2);
  });

  it('keeps an agent paused to make room at the head of the queue, before the replies', () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'reply'));
    q.add({ ...wait('BL-2', 'resume'), front: true });
    q.add(wait('BL-3', 'review'));
    expect(q.ordered().map((w) => w.id)).toEqual(['BL-2', 'BL-1', 'BL-3']);
  });

  it('finds a wait by its item', () => {
    const q = new StartQueue<string>();
    q.add(wait('BL-1', 'reply'));
    expect(q.get('BL-1')?.kind).toBe('reply');
    expect(q.get('BL-9')).toBeUndefined();
  });
});

describe('Prioritize', () => {
  it('takes a free slot, then an extra agent above the limit while fewer than the ceiling run above it', () => {
    expect(prioritizeAction({ running: 1, limit: 2, maxExtra: 2, memoryShort: false })).toBe('start');
    expect(prioritizeAction({ running: 2, limit: 2, maxExtra: 2, memoryShort: false })).toBe('start');
    expect(prioritizeAction({ running: 3, limit: 2, maxExtra: 2, memoryShort: false })).toBe('start');
  });

  it('asks for an agent to pause at the ceiling', () => {
    expect(prioritizeAction({ running: 4, limit: 2, maxExtra: 2, memoryShort: false })).toBe('pause');
  });

  it('with a ceiling of 0, a start without a free slot asks for a pause; only a free slot is taken otherwise', () => {
    expect(prioritizeAction({ running: 2, limit: 2, maxExtra: 0, memoryShort: false })).toBe('pause');
    expect(prioritizeAction({ running: 1, limit: 2, maxExtra: 0, memoryShort: false })).toBe('start');
  });

  it('starts nothing while memory is short, a free slot or not', () => {
    expect(prioritizeAction({ running: 0, limit: 2, maxExtra: 2, memoryShort: true })).toBe('memory');
    expect(prioritizeAction({ running: 4, limit: 2, maxExtra: 2, memoryShort: true })).toBe('memory');
  });
});

describe('the agent to pause', () => {
  const run = (name: string, reviewer: boolean, ranForMs: number, busy = false) => ({ name, reviewer, ranForMs, busy });

  it('is a reviewer first, then an agent that just started, and one running a build or tests last', () => {
    const order = pauseOrder([
      run('work, long', false, 40 * 60_000),
      run('build, reviewing', true, 2 * 60_000, true),
      run('work, just started', false, 60_000),
      run('reviewer, long', true, 30 * 60_000),
    ]).map((r) => r.name);
    expect(order).toEqual(['reviewer, long', 'work, just started', 'work, long', 'build, reviewing']);
  });

  it('pauses the one that has run the least, among those that cost the same', () => {
    const order = pauseOrder([run('older', true, 20 * 60_000), run('newer', true, 3 * 60_000)]).map((r) => r.name);
    expect(order).toEqual(['newer', 'older']);
  });
});

describe('the ordinal of a place', () => {
  it('reads 1st, 2nd, 3rd, then 4th, and 11th to 13th as th', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
      '111th',
    ]);
  });
});
