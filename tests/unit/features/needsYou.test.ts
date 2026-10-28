import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import type { ReviewState } from '../../../src/features/backlog/review';
import {
  isWarning,
  needsYouList,
  needsYouMessage,
  type NeedsYouNote,
  type NeedsYouWorktree,
  newNeeds,
} from '../../../src/features/needsYou';

function item(id: string, extra: Partial<BacklogItem> = {}): BacklogItem {
  return { id, title: `Title of ${id}`, status: 'review', priority: 'medium', created: '2026-10-12T09:00:00Z', ...extra } as BacklogItem;
}

function review(state: ReviewState['state'], extra: Partial<ReviewState> = {}): ReviewState {
  return { round: 1, state, reviewer: 'Nova-7', ...extra };
}

function worktree(key: string, attention: NeedsYouWorktree['attention'], current = false): NeedsYouWorktree {
  return { key, label: `feature/${key}`, attention, current };
}

function note(id: string, extra: Partial<NeedsYouNote> = {}): NeedsYouNote {
  return { id, title: `Note ${id}`, status: 'asking', agent: 'Orbit-5', ...extra };
}

describe('needsYouList', () => {
  it('lists the notes whose agent asks, with the tickets that ask, and not those handled with another', () => {
    const notes = [note('NOTE-2'), note('NOTE-3', { with: 'NOTE-2' }), note('NOTE-4', { status: 'open' }), note('NOTE-5', { status: 'handled' })];
    const list = needsYouList([item('BL-1', { review: review('asking') }), item('BL-6', { review: review('yours') })], [], notes);
    expect(list.map((n) => n.key)).toEqual(['asks:BL-1', 'asks:NOTE-2', 'review:BL-6']);
    expect(list[1].note).toEqual({ id: 'NOTE-2', title: 'Note NOTE-2' });
    expect(needsYouMessage([list[1]])).toBe('NOTE-2 asks a question.');
    expect(needsYouMessage(needsYouList([], [], [note('NOTE-2'), note('NOTE-7')]))).toBe('2 notes need you: NOTE-2 and NOTE-7 ask questions.');
  });

  it('lists the tickets waiting for the user, by kind', () => {
    const items = [
      item('BL-1', { review: review('yours') }),
      item('BL-2', { review: review('asking') }),
      item('BL-3', { review: review('approved') }),
      item('BL-4', { review: review('stopped', { stop: { kind: 'rounds' } }) }),
      item('BL-5', { proposed: { by: 'Nova-7' }, status: 'todo' }),
    ];
    expect(needsYouList(items, []).map((n) => n.key)).toEqual(['asks:BL-2', 'stopped:BL-4', 'review:BL-1', 'approved:BL-3', 'proposed:BL-5']);
  });

  it('tells of a merge that stopped as a warning, and of a resolution that waits for you, not "ready to merge" (BL-229)', () => {
    const merging = (state: 'resolving' | 'resolved' | 'failed', stopped?: boolean) =>
      ({
        dir: 'd',
        branch: 'b',
        base: 'main',
        baseTip: 't',
        state,
        started: 'S',
        ...(state === 'failed'
          ? { checks: { command: 'npm test', output: '', runs: [{ log: 'l', at: 'F', ms: 1, timeouts: 0, failures: [], stopped }] } }
          : {}),
      }) as BacklogItem['merging'];
    const items = [
      item('BL-1', { review: review('approved'), merging: merging('failed', true) }),
      item('BL-2', { review: review('approved'), merging: merging('failed') }),
      item('BL-3', { review: review('approved'), merging: merging('resolving') }),
      item('BL-4', { review: review('approved'), merging: merging('resolved') }),
    ];
    const list = needsYouList(items, []);
    expect(list.map((n) => n.key)).toEqual(['merge:BL-1', 'merge:BL-2', 'resolved:BL-4']);
    expect(isWarning('merge')).toBe(true);
    expect(isWarning('resolved')).toBe(false);
    expect(needsYouMessage([list[0]])).toBe('BL-1 has a merge that stopped.');
    expect(needsYouMessage([list[2]])).toBe('BL-4 has a merge waiting for your approval.');
  });

  it('leaves out work agents do by themselves, done items, and reviews the user stopped', () => {
    const items = [
      item('BL-1', { status: 'doing', review: review('working') }),
      item('BL-2', { status: 'doing', review: review('revising') }),
      item('BL-3', { status: 'review', review: review('reviewing') }),
      item('BL-4', { status: 'review', review: review('paused') }),
      item('BL-5', { status: 'done', review: review('yours') }),
      item('BL-6', { status: 'review', review: review('stopped', { stop: { kind: 'user' } }) }),
      item('BL-7'),
    ];
    expect(needsYouList(items, [])).toEqual([]);
  });

  it('adds worktrees waiting for input or reporting an error, and says which one is this window', () => {
    const list = needsYouList([], [worktree('a', 'waiting-for-input'), worktree('b', 'error', true), worktree('c', 'working')]);
    expect(list.map((n) => n.key)).toEqual(['error:b', 'waiting:a']);
    expect(list[0].worktree).toEqual({ key: 'b', label: 'feature/b', current: true });
  });

  it('puts the errors and questions before the reviews, and names in order', () => {
    const items = [item('BL-12', { review: review('yours') }), item('BL-4', { review: review('asking') }), item('BL-13', { review: review('yours') })];
    expect(needsYouList(items, [worktree('x', 'error')]).map((n) => n.key)).toEqual(['error:x', 'asks:BL-4', 'review:BL-12', 'review:BL-13']);
  });
});

describe('newNeeds', () => {
  it('is nothing on the first list: what was there when the window opened is not news', () => {
    expect(newNeeds(undefined, needsYouList([item('BL-1', { review: review('yours') })], []))).toEqual([]);
  });

  it('is the needs that were not in the previous list', () => {
    const before = new Set(['review:BL-1']);
    const next = needsYouList([item('BL-1', { review: review('yours') }), item('BL-2', { review: review('asking') })], []);
    expect(newNeeds(before, next).map((n) => n.key)).toEqual(['asks:BL-2']);
  });

  it('counts a changed kind as news', () => {
    const before = new Set(['review:BL-1']);
    const next = needsYouList([item('BL-1', { review: review('approved') })], []);
    expect(newNeeds(before, next).map((n) => n.key)).toEqual(['approved:BL-1']);
  });
});

describe('needsYouMessage', () => {
  it('says one need as a sentence', () => {
    const [n] = needsYouList([item('BL-4', { review: review('asking') })], []);
    expect(needsYouMessage([n])).toBe('BL-4 asks a question.');
  });

  it('groups the needs by kind, as one line', () => {
    const list = needsYouList(
      [item('BL-4', { review: review('asking') }), item('BL-12', { review: review('yours') }), item('BL-13', { review: review('yours') })],
      [],
    );
    expect(needsYouMessage(list)).toBe('3 tickets need you: BL-4 asks a question, BL-12 and BL-13 are ready for your review.');
  });

  it('names three in a group with commas and "and"', () => {
    const list = needsYouList(
      [item('BL-1', { review: review('yours') }), item('BL-2', { review: review('yours') }), item('BL-3', { review: review('yours') })],
      [],
    );
    expect(needsYouMessage(list)).toBe('3 tickets need you: BL-1, BL-2 and BL-3 are ready for your review.');
  });

  it('says worktrees and mixed needs by their nouns', () => {
    expect(needsYouMessage(needsYouList([], [worktree('a', 'waiting-for-input'), worktree('b', 'waiting-for-input')]))).toBe(
      '2 worktrees need you: feature/a and feature/b are waiting for input.',
    );
    const mixed = needsYouList([item('BL-1', { review: review('yours') })], [worktree('a', 'error')]);
    expect(needsYouMessage(mixed)).toBe('2 items need you: feature/a reported an error, BL-1 is ready for your review.');
  });
});
