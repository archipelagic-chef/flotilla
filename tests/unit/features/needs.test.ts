import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type BacklogData,
  type BacklogItem,
  setStartFailed,
} from '../../../src/features/backlog/backlog';
import {
  holdsUpLine,
  needOf,
  needsYouRows,
  noteNeed,
  oldestFirst,
  resumeAsk,
} from '../../../src/features/backlog/needs';
import {
  type ReviewState,
  stampWaiting,
} from '../../../src/features/backlog/review';
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
    // Discarded as won't do (BL-209): nothing waits on the user.
    expect(needOf(item({ review: review({ state: 'approved' }), discarded: { at: 'T' } }), [])).toBeUndefined();
  });

  it('gives a stopped review its reason; one the user stopped is still theirs to decide', () => {
    const stopped = review({ state: 'stopped', reason: 'still not approved after 3 rounds; it’s yours to decide.', stop: { kind: 'rounds' } });
    expect(needOf(item({ review: stopped }), [])?.line).toBe('Stopped: still not approved after 3 rounds; it’s yours to decide.');
    expect(needOf(item({ review: review({ state: 'stopped', reason: 'stopped by you.', stop: { kind: 'user' } }) }), [])?.line).toBe('You stopped the review');
  });

  it('shows a start the autopilot couldn’t make, while the item is still To Do', () => {
    const failed = { message: 'no worktree free.', since: '2026-10-12T09:00:00.000Z' };
    expect(needOf(item({ status: 'todo', startFailed: failed }), [])).toEqual({
      kind: 'failed',
      since: failed.since,
      line: "Couldn't start: no worktree free.",
    });
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

describe('an approved ticket being merged (BL-229)', () => {
  const merging = (state: 'resolving' | 'resolved' | 'failed', reason?: string, stopped?: boolean) =>
    ({
      dir: 'd',
      branch: 'b',
      base: 'main',
      baseTip: 't',
      state,
      started: 'S',
      ...(reason ? { reason } : {}),
      ...(state === 'failed'
        ? { checks: { command: 'npm test', output: '', at: 'F', runs: [{ log: 'l', at: 'F', ms: 1, timeouts: 0, failures: [], stopped }] } }
        : {}),
    }) as BacklogItem['merging'];
  const approved = (m: BacklogItem['merging']) => item({ status: 'review', review: review({ state: 'approved', reviewer: 'Nova-9' }), merging: m });

  it('says where its merge is, in the card’s words, not "Ready to merge"', () => {
    expect(needOf(approved(merging('failed', 'you stopped the checks (`npm test`).', true)), [])).toEqual({
      kind: 'merge',
      since: 'F',
      line: 'Merge stopped: you stopped its checks. Run them again, or cancel it.',
    });
    expect(needOf(approved(merging('failed', 'the checks failed (`npm test`).')), [])).toEqual({
      kind: 'merge',
      since: 'F',
      line: 'Merge failed: the checks failed (npm test).',
    });
    expect(needOf(approved(merging('resolved')), [])).toEqual({ kind: 'merge', since: 'S', line: 'Waiting for you: approve the merge' });
  });

  it('leaves out a merge an agent resolves', () => {
    expect(needOf(approved(merging('resolving')), [])).toBeUndefined();
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

describe('an agent that stopped to be resumed (BL-198)', () => {
  const asking = item({ review: review({ state: 'asking', implementer: 'Nova-7' }) });
  const report = (body: string) => [entry('Agent Nova-7', body)];

  it('is resumed when its latest report asks nothing, with the tickets it waits for', () => {
    const body =
      "Waiting for BL-182: its notes aren't on main.\n\nNeeds from you: nothing. Resume me once BL-182 is merged.\n\nDetails: BL-9 is merged already.";
    expect(resumeAsk(asking, report(body))).toEqual({ waits: ['BL-182'] });
    expect(resumeAsk(asking, report('Stopped here.\n\nNeeds from you: nothing'))).toEqual({ waits: [] });
  });

  it('is answered, not resumed, when the report asks a question or waits for the user', () => {
    expect(resumeAsk(asking, report('Which?\n\nNeeds from you: a choice\n\n```question\nWhich one?\n- A\n- B\n```'))).toBeUndefined();
    expect(resumeAsk(asking, report('Which one, A or B?\n\nWaiting for you.'))).toBeUndefined();
  });

  it('is only for a ticket whose agent asks', () => {
    expect(resumeAsk(item({ review: review({ state: 'yours', implementer: 'Nova-7' }) }), report('Done.\n\nNeeds from you: nothing'))).toBeUndefined();
    expect(resumeAsk(asking, [])).toBeUndefined();
  });
});

describe('notes in Needs you (BL-192)', () => {
  const note = (id: string, over: Partial<Parameters<typeof noteNeed>[0]> = {}) => ({ id, status: 'asking', agent: 'Vega-2', ...over });

  it('lists a note whose agent asks, with who asks and since its reply', () => {
    expect(noteNeed(note('NOTE-3', { asks: { since: '2026-10-25T12:00:00.000Z' } }))).toEqual({
      kind: 'asking',
      since: '2026-10-25T12:00:00.000Z',
      line: 'Vega-2 asks you',
    });
    expect(noteNeed(note('NOTE-3', { agent: undefined }))?.line).toBe('Its agent asks you');
  });

  it('leaves out notes that ask nothing, and those handled with the one that asks', () => {
    for (const status of ['open', 'working', 'handled']) expect(noteNeed(note('NOTE-1', { status }))).toBeUndefined();
    expect(noteNeed(note('NOTE-2', { with: 'NOTE-1' }))).toBeUndefined();
  });

  it('puts asking notes among the tickets, oldest waiting first, one entry each', () => {
    const items = [
      { id: 'BL-1', need: { kind: 'yours' as const, since: '2026-10-25T10:00:00.000Z', line: 'Ready for your review' } },
      { id: 'BL-2' },
      { id: 'BL-3', need: { kind: 'approved' as const, since: '2026-10-25T13:00:00.000Z', line: 'Approved' } },
    ];
    const notes = [note('NOTE-1', { asks: { since: '2026-10-25T11:00:00.000Z' } }), note('NOTE-2', { with: 'NOTE-1' }), note('NOTE-4', { status: 'working' })];
    const rows = needsYouRows(items, notes);
    expect(rows.map((r) => r.item?.id ?? r.note?.id)).toEqual(['BL-1', 'NOTE-1', 'BL-3']);
    expect(rows[1].need?.line).toBe('Vega-2 asks you');
  });
});

describe('rows that hold tickets up (BL-238)', () => {
  const need = (since: string) => ({ kind: 'approved' as const, since, line: 'Approved' });

  it('come first, then the oldest waiting', () => {
    const items = [
      { id: 'BL-1', need: need('2026-10-25T10:00:00.000Z') },
      { id: 'BL-2', need: need('2026-10-25T12:00:00.000Z'), holdsUp: ['BL-9'] },
      { id: 'BL-3', need: need('2026-10-25T11:00:00.000Z'), holdsUp: ['BL-7', 'BL-8'] },
    ];
    expect(needsYouRows(items, []).map((r) => r.item?.id)).toEqual(['BL-3', 'BL-2', 'BL-1']);
  });

  it('say which, or how many', () => {
    expect(holdsUpLine(['BL-208'])).toBe('holds up BL-208');
    expect(holdsUpLine(['BL-211', 'BL-213'])).toBe('holds up 2 tickets');
  });

  it('include a review the user stopped or paused themselves', () => {
    const stopped = item({ status: 'review', review: review({ state: 'stopped', stop: { kind: 'user' } }) });
    expect(needOf(stopped, [])?.kind).toBe('stopped');
    const paused = item({ status: 'review', review: review({ state: 'paused', paused: { byUser: '2026-10-28T10:00:00Z' } } as Partial<ReviewState>) });
    expect(needOf(paused, [])?.kind).toBe('stopped');
  });
});
