import { describe, expect, it } from 'vitest';
import { awayLine, finished, idleReason, wasOvernight } from '../../../src/features/backlog/autopilotIdle';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';

const at = '2026-10-21T00:00:00Z';
const item = (id: string, status: BacklogItem['status'], more: Partial<BacklogItem> = {}): BacklogItem => ({ id, title: id, status, created: at, ...more });
const data = (...items: BacklogItem[]): BacklogData => ({ version: 1, next: 99, items });

describe("why the autopilot is idle (BL-142)", () => {
  it('names the ticket that waits, and for which, with where that one stands', () => {
    const d = data(item('BL-126', 'review'), item('BL-130', 'todo'), item('BL-131', 'todo'));
    const waits = new Map([['BL-130', ['BL-126']], ['BL-131', ['BL-126']]]);
    expect(idleReason(d, waits, new Set())).toBe('BL-130 waits for BL-126 (in review) (and 1 more wait)');
  });

  it("isn't idle while a ticket can start", () => {
    const d = data(item('BL-126', 'review'), item('BL-130', 'todo'), item('BL-131', 'todo'));
    expect(idleReason(d, new Map([['BL-130', ['BL-126']]]), new Set())).toBeUndefined();
  });

  it('says which merges failed, and that they need the user', () => {
    const failed = { merging: { state: 'failed' } } as unknown as Partial<BacklogItem>;
    const d = data(item('BL-120', 'review', failed), item('BL-121', 'review', failed), item('BL-122', 'review', failed), item('BL-123', 'review', failed));
    expect(idleReason(d, new Map(), new Set())).toBe('4 merges failed (BL-120, BL-121, …): they need you');
    const waiting = data(...d.items, item('BL-130', 'todo'));
    expect(idleReason(waiting, new Map([['BL-130', ['BL-120']]]), new Set())).toBe('BL-130 waits for BL-120 (merge failed) · 4 merges failed (BL-120, BL-121, …): they need you');
  });

  it("says when nothing is left, and when a start failed", () => {
    expect(idleReason(data(item('BL-1', 'done'), item('BL-2', 'todo', { proposed: {} })), new Map(), new Set())).toBe('nothing left in To Do');
    expect(idleReason(data(item('BL-3', 'todo')), new Map(), new Set(['BL-3']))).toBe("BL-3 couldn't start: start it yourself");
  });
});

describe('what the autopilot did while the user was away (BL-142)', () => {
  it('counts the tickets done meanwhile and those waiting for the user', () => {
    const before = finished(data(item('BL-1', 'review'), item('BL-2', 'doing'), item('BL-3', 'doing')));
    const after = data(
      item('BL-1', 'done'),
      item('BL-2', 'review', { review: { state: 'yours' } as BacklogItem['review'] }),
      item('BL-3', 'review', { review: { state: 'reviewing' } as BacklogItem['review'] }),
    );
    expect(awayLine(before, after, true)).toBe('Overnight: 2 tickets done, 1 waiting for you');
    expect(awayLine(before, after, false)).toBe('While you were away: 2 tickets done, 1 waiting for you');
    expect(awayLine(finished(after), data(item('BL-1', 'done')), true)).toBeUndefined();
  });

  it('calls an absence of 4 hours or more past 3 am overnight', () => {
    expect(wasOvernight(new Date(2026, 9, 20, 22, 30), new Date(2026, 9, 21, 7, 0))).toBe(true);
    expect(wasOvernight(new Date(2026, 9, 21, 9, 0), new Date(2026, 9, 21, 17, 0))).toBe(false);
    expect(wasOvernight(new Date(2026, 9, 21, 2, 0), new Date(2026, 9, 21, 4, 0))).toBe(false);
  });
});
