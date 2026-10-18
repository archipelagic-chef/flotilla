import { describe, expect, it } from 'vitest';
import { setStartFailed, type BacklogData, type BacklogItem } from '../../../src/features/backlog/backlog';
import { needOf, oldestFirst } from '../../../src/features/backlog/needs';
import { stampWaiting, type ReviewState } from '../../../src/features/backlog/review';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

const item = (over: Partial<BacklogItem> = {}): BacklogItem => ({
  id: 'BL-1',
  title: 'Thing',
  status: 'doing',
  created: '2026-10-01T10:00:00.000Z',
  ...over,
});

const review = (over: Partial<ReviewState> = {}): ReviewState => ({ round: 1, state: 'reviewing', reviewer: 'Ada-1', ...over });

const entry = (author: string, body: string, date = '2026-10-12 10:00'): TicketEntry => ({ date, author, body });

describe('needOf', () => {
  it('asks the question with the implementer’s last report: its first line', () => {
    const activity = [
      entry('Agent Nova-7', 'Earlier report.'),
      entry('Agent Ada-1', 'Reviewer note.'),
      entry('Agent Nova-7', '## Which database?\n\nPostgres or SQLite.\n\nWaiting for you.'),
    ];
    const need = needOf(item({ review: review({ state: 'asking', implementer: 'Nova-7', since: '2026-10-12T10:00:00.000Z' }) }), activity);
    expect(need).toEqual({ kind: 'asking', since: '2026-10-12T10:00:00.000Z', line: 'Which database?' });
  });

  it('says ready for review when the work waits for the user', () => {
    expect(needOf(item({ review: review({ state: 'yours', since: 'T' }) }), [])).toEqual({ kind: 'yours', since: 'T', line: 'Ready for your review' });
  });

  it('says who approved it, while it is not merged (done items are)', () => {
    expect(needOf(item({ review: review({ state: 'approved', reviewer: 'Ada-1' }) }), [])?.line).toBe('Approved by Ada-1. Ready to merge.');
    expect(needOf(item({ review: review({ state: 'approved', byUser: true }) }), [])?.line).toBe('Approved by you. Ready to merge.');
    expect(needOf(item({ status: 'done', review: review({ state: 'approved' }) }), [])).toBeUndefined();
  });

  it('gives a stopped review its reason; one the user stopped is still theirs to decide', () => {
    const stopped = review({ state: 'stopped', reason: 'still not approved after 3 rounds; it’s yours to decide.', stop: { kind: 'rounds' } });
    expect(needOf(item({ review: stopped }), [])?.line).toBe('Stopped: still not approved after 3 rounds; it’s yours to decide.');
    expect(needOf(item({ review: review({ state: 'stopped', reason: 'stopped by you.', stop: { kind: 'user' } }) }), [])?.line).toBe('You stopped the review');
  });

  it('shows a start the autopilot couldn’t make, while the item is still To Do', () => {
    const failed = { message: 'no worktree free.', since: '2026-10-12T09:00:00.000Z' };
    expect(needOf(item({ status: 'todo', startFailed: failed }), [])).toEqual({ kind: 'failed', since: failed.since, line: "Couldn't start: no worktree free." });
    expect(needOf(item({ status: 'doing', startFailed: failed }), [])).toBeUndefined();
  });

  it('leaves out what does not wait on the user', () => {
    expect(needOf(item({ review: review({ state: 'working' }) }), [])).toBeUndefined();
    expect(needOf(item({ review: review({ state: 'reviewing' }) }), [])).toBeUndefined();
    expect(needOf(item({ proposed: { by: 'Ada-1' }, review: review({ state: 'yours' }) }), [])).toBeUndefined();
    expect(needOf(item(), [])).toBeUndefined();
  });

  it('lists an item in review that no reviewer agent is at as the user’s review', () => {
    expect(needOf(item({ status: 'review' }), [])).toEqual({ kind: 'yours', line: 'Ready for your review' });
    expect(needOf(item({ status: 'review', review: review({ state: 'revising' }) }), [])).toBeUndefined();
  });
});

describe('oldestFirst', () => {
  it('lists the waiting items oldest first, the ones without a start last', () => {
    const rows = [
      { id: 'new', need: { kind: 'yours' as const, since: '2026-10-12T12:00:00.000Z', line: '' } },
      { id: 'none', need: { kind: 'stopped' as const, line: '' } },
      { id: 'idle' },
      { id: 'old', need: { kind: 'asking' as const, since: '2026-10-10T08:00:00.000Z', line: '' } },
    ];
    expect(oldestFirst(rows).map((r) => r.id)).toEqual(['old', 'new', 'none']);
  });
});

describe('stampWaiting', () => {
  it('stamps when a review comes to a state that waits on the user', () => {
    const before = review({ state: 'revising' });
    expect(stampWaiting(before, review({ state: 'asking' }), 'NOW')).toMatchObject({ state: 'asking', since: 'NOW' });
  });

  it('keeps the start of a wait while it goes on, and leaves other states alone', () => {
    const waiting = review({ state: 'yours', since: 'OLD' });
    expect(stampWaiting(waiting, review({ state: 'yours', since: 'OLD', reason: 'x' }), 'NOW').since).toBe('OLD');
    expect(stampWaiting(waiting, review({ state: 'revising' }), 'NOW').since).toBeUndefined();
  });
});

describe('setStartFailed', () => {
  const data: BacklogData = { version: 1, next: 1, items: [item({ id: 'BL-1' }), item({ id: 'BL-2' })] };

  it('records the failure on its item only, and clears it again', () => {
    const failed = setStartFailed(data, 'BL-2', { message: 'busy', since: 'T' });
    expect(failed.items.map((i) => i.startFailed)).toEqual([undefined, { message: 'busy', since: 'T' }]);
    expect(setStartFailed(failed, 'BL-2').items[1]).not.toHaveProperty('startFailed');
  });
});
