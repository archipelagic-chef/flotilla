import { describe, expect, it } from 'vitest';
import { entryRound, foldRounds, foldTitle, reviewOutcome, type FeedGroup, type RoundInfo } from '../../../src/features/backlog/rounds';
import type { TicketEntry } from '../../../src/features/backlog/ticket';

const entry = (date: string, author: string, body: string): TicketEntry => ({ date, author, body });
/** A commit in the feed, as the webview has it: a round's part, and the subject. */
const commit = (subject: string) => ({ commit: subject });
type Item = TicketEntry | ReturnType<typeof commit>;
const info = (item: Item): RoundInfo => ('commit' in item ? { part: 'round' } : entryRound(item));

const started = entry('2026-10-11 09:00', 'Flotilla', 'Review round 1: opened a chat for agent Flux-3 in worktree `w`. It reviews Vega-3 and gives a verdict here.');
const ready = entry('2026-10-11 08:50', 'Agent Vega-3', 'Done.\n\nReady for review.');
const changes = entry('2026-10-11 09:20', 'Agent Flux-3', 'Fix the tests.\n\nVerdict: changes requested');
const revision = entry('2026-10-11 09:21', 'Flotilla', 'Review round 1: Flux-3 requested changes; resumed a chat for agent Vega-3 to make them.');
const approved = entry('2026-10-11 10:30', 'Agent Flux-3', 'Looks good.\n\nVerdict: approved');
const moved = entry('2026-10-11 08:51', 'Flotilla', 'Vega-3 (an agent) moved it from **In Progress** to **In Review**.');
const pushed = entry('2026-10-11 09:25', 'Flotilla', 'Pushed `b` to origin at `a52a369` (4 new commits), so CI runs on it.');

/** The groups' shape: a fold's reviewer, rounds, outcome and how many items it holds, or the item's subject. */
const shape = (groups: Array<FeedGroup<Item>>) =>
  groups.map((g) =>
    'fold' in g
      ? { reviewer: g.fold.reviewer, rounds: g.fold.rounds, outcome: g.fold.outcome, items: g.fold.items.length }
      : 'commit' in g.item
        ? g.item.commit
        : g.item.body.split('\n')[0],
  );

describe('reading an entry\'s part in a review', () => {
  it('opens a review at its first round, and a round after the user\'s review', () => {
    expect(entryRound(started)).toEqual({ part: 'open', round: 1, reviewer: 'Flux-3' });
    expect(entryRound(revision)).toEqual({ part: 'open', round: 1 });
  });

  it('reads a "Ready for review" report as the implementer\'s, which no fold holds', () => {
    expect(entryRound(ready)).toEqual({ part: 'report' });
  });

  it("reads Flotilla's status notes as notes, which don't split a review", () => {
    expect(entryRound(moved)).toEqual({ part: 'note' });
    expect(entryRound(pushed)).toEqual({ part: 'note' });
    expect(entryRound(entry('2026-10-11 09:30', 'Flotilla', 'Branch `b` now conflicts with main (`a.ts`).'))).toEqual({ part: 'note' });
  });

  it('keeps verdicts in the rounds, and an approval closes the review', () => {
    expect(entryRound(changes)).toEqual({ part: 'round', verdict: 'changes', agent: 'Flux-3' });
    expect(entryRound(approved)).toEqual({ part: 'close', verdict: 'approved', agent: 'Flux-3' });
  });

  it("never folds the user's entries, questions to the user, or what stopped the review", () => {
    expect(entryRound(entry('2026-10-11 10:00', 'You', 'Verdict: approved'))).toEqual({ part: 'stay' });
    expect(entryRound(entry('2026-10-11 10:00', 'Agent Vega-3', 'Which key?\n\nWaiting for you.'))).toEqual({ part: 'stay' });
    expect(entryRound(entry('2026-10-11 10:00', 'Flotilla', 'The review stopped: no verdict.'))).toEqual({ part: 'stay' });
    expect(entryRound(entry('2026-10-11 10:00', 'Flotilla', 'You answered Vega-3\'s question; resumed a chat.'))).toEqual({ part: 'stay' });
    expect(entryRound(entry('2026-10-11 10:00', 'Jane', 'Looks fine to me.'))).toEqual({ part: 'stay' });
  });

  it('counts a usage limit that paused a round as part of it', () => {
    expect(entryRound(entry('2026-10-11 10:00', 'Flotilla', "Vega-3 stopped on Claude's usage limit. It goes on by itself when it resets."))).toEqual({ part: 'round' });
    expect(entryRound(entry('2026-10-11 10:00', 'Flotilla', 'The limit reset: resumed the chat for agent Vega-3 to go on.'))).toEqual({ part: 'round' });
  });
});

describe('folding a review\'s rounds', () => {
  it('folds a review from its first round to its approval, with the rounds it went through', () => {
    const feed: Item[] = [entry('2026-10-11 08:00', 'Agent Vega-3', 'Started on it.'), ready, started, changes, revision, commit('BL-40: fix'), approved];
    expect(shape(foldRounds(feed, info))).toEqual([
      'Started on it.',
      'Done.',
      { reviewer: 'Flux-3', rounds: 2, outcome: 'approved', items: 5 },
    ]);
  });

  it('leaves the implementer\'s work and its "Ready for review" report visible, and the commits made before it', () => {
    const feed: Item[] = [commit('BL-40: first cut'), entry('2026-10-11 08:40', 'Agent Vega-3', 'Still at the tests.'), ready, started, changes, approved, commit('BL-40: after')];
    expect(shape(foldRounds(feed, info))).toEqual([
      'BL-40: first cut',
      'Still at the tests.',
      'Done.',
      { reviewer: 'Flux-3', rounds: 2, outcome: 'approved', items: 3 },
      'BL-40: after',
    ]);
  });

  it("keeps BL-110's Done report in the feed, and its review in one fold, across Flotilla's notes", () => {
    const plan = entry('2026-10-19 20:20', 'Agent Vega-2', 'Plan: gather the attachments.\nNeeds from you: nothing');
    const done = entry('2026-10-20 00:45', 'Agent Vega-2', 'Done: a ticket has an Attachments section.\nNeeds from you: nothing\n\nReady for review.');
    const moved2 = entry('2026-10-20 00:42', 'Flotilla', 'Vega-2 (an agent) moved it from **In Progress** to **In Review**.');
    const round1 = entry('2026-10-20 00:42', 'Flotilla', 'Review round 1: opened a chat for agent Wren-2 (opus) in worktree `w`. It reviews Vega-2 and gives a verdict here.');
    const ok = entry('2026-10-20 00:43', 'Agent Wren-2', 'Verdict: approved\nThe section works.');
    const push = entry('2026-10-20 00:44', 'Flotilla', 'Pushed `b` to origin at `a52a369` (4 new commits), so CI runs on it.');
    const feed: Item[] = [plan, done, moved2, round1, ok, push, entry('2026-10-20 06:05', 'You', 'Verdict: approved')];
    expect(shape(foldRounds(feed, info))).toEqual([
      'Plan: gather the attachments.',
      'Done: a ticket has an Attachments section.',
      'Vega-2 (an agent) moved it from **In Progress** to **In Review**.',
      { reviewer: 'Wren-2', rounds: 1, outcome: 'approved', items: 2 },
      'Pushed `b` to origin at `a52a369` (4 new commits), so CI runs on it.',
      'Verdict: approved',
    ]);
  });

  it("doesn't let Flotilla's notes in a review split it", () => {
    const feed: Item[] = [ready, started, pushed, changes, revision, moved, approved];
    expect(shape(foldRounds(feed, info))).toEqual(['Done.', { reviewer: 'Flux-3', rounds: 2, outcome: 'approved', items: 6 }]);
  });

  it('leaves a report that no review has looked at yet unfolded', () => {
    expect(shape(foldRounds([ready, moved], info, { state: 'reviewing' }))).toEqual(['Done.', moved.body]);
  });

  it("keeps each round's report in the feed: the rounds before it fold, and the round after it", () => {
    const again = entry('2026-10-11 09:50', 'Agent Vega-3', 'Fixed the tests.\n\nReady for review.');
    const round2 = entry('2026-10-11 09:51', 'Flotilla', 'Review round 2: resumed a chat for agent Flux-3 in worktree `w`. It reviews Vega-3 and gives a verdict here.');
    const feed: Item[] = [ready, started, changes, revision, commit('BL-40: fix'), again, round2, approved];
    const groups = foldRounds(feed, info);
    expect(shape(groups)).toEqual([
      'Done.',
      { reviewer: 'Flux-3', rounds: 1, outcome: 'changes requested', items: 4 },
      'Fixed the tests.',
      { reviewer: 'Flux-3', rounds: 1, outcome: 'approved', items: 2 },
    ]);
    expect(groups.flatMap((g) => ('fold' in g ? [foldTitle(g.fold)] : []))).toEqual([
      'Reviewed by Flux-3 in 1 round → changes requested',
      'Reviewed by Flux-3 in round 2 → approved',
    ]);
    // While round 2 runs, its fold says so, and the second report stays out of it.
    expect(shape(foldRounds([ready, started, changes, revision, again, round2], info, { state: 'reviewing' })).slice(2)).toEqual([
      'Fixed the tests.',
      { reviewer: 'Flux-3', rounds: 1, outcome: 'round 2 running', items: 1 },
    ]);
  });

  it("stops a review at the user's review, which stays, and folds the next round after it", () => {
    const userReview = entry('2026-10-11 10:00', 'You', 'Use the config file.\n\nVerdict: changes requested');
    const again = entry('2026-10-11 10:01', 'Flotilla', 'Review round 2: you requested changes; resumed a chat for agent Vega-3 to make them.');
    const feed: Item[] = [ready, started, changes, userReview, again, ready];
    expect(shape(foldRounds(feed, info))).toEqual([
      'Done.',
      { reviewer: 'Flux-3', rounds: 1, outcome: 'changes requested', items: 2 },
      'Use the config file.',
      // The note of the user's request stays visible (it isn't folded into the next review).
      'Review round 2: you requested changes; resumed a chat for agent Vega-3 to make them.',
      'Done.',
    ]);
  });

  it("keeps the note of the user's requested changes visible, whatever round it names", () => {
    expect(entryRound(entry('2026-10-11 10:01', 'Flotilla', 'Review round 1: you requested changes; resumed a chat for agent Vega-3 to make them.'))).toEqual({
      part: 'stay',
    });
  });

  it('shows a review that is still going on by where it is, from the ticket\'s state', () => {
    const feed: Item[] = [ready, started, changes, revision];
    const trailing = foldRounds(feed, info, { state: 'reviewing', reviewer: 'Flux-3' });
    expect(shape(trailing)).toEqual(['Done.', { reviewer: 'Flux-3', rounds: 1, outcome: 'changes requested, round 2 running', items: 3 }]);
    expect(shape(foldRounds(feed, info, { state: 'yours' }))).toEqual(['Done.', { reviewer: 'Flux-3', rounds: 1, outcome: 'waiting for you', items: 3 }]);
    // Only the last of the feed takes the state: an earlier review is what it was.
    expect(shape(foldRounds([...feed, entry('2026-10-11 11:00', 'You', 'Thanks.')], info, { state: 'reviewing' }))[1]).toMatchObject({ outcome: 'changes requested' });
  });

  it('gives a review that hasn\'t got a verdict yet the round it is in', () => {
    expect(shape(foldRounds([ready, started], info, { state: 'reviewing', reviewer: 'Flux-3' }))).toEqual([
      'Done.',
      { reviewer: 'Flux-3', rounds: 1, outcome: 'round 1 running', items: 1 },
    ]);
    // After a comment of the user's split it, the round it's in is the one its note names.
    const second = entry('2026-10-11 10:01', 'Flotilla', 'Review round 2: resumed a chat for agent Flux-3 in worktree `w`. It reviews Vega-3 and gives a verdict here.');
    expect(shape(foldRounds([ready, second], info, { state: 'reviewing' }))).toEqual([
      'Done.',
      { reviewer: 'Flux-3', rounds: 1, outcome: 'round 2 running', items: 1 },
    ]);
  });

  it('leaves a feed without any review as it is', () => {
    const feed: Item[] = [entry('2026-10-11 08:00', 'Agent Vega-3', 'Did X.'), commit('BL-40: x'), entry('2026-10-11 09:00', 'You', 'Thanks.')];
    expect(foldRounds(feed, info).every((g) => 'item' in g)).toBe(true);
    expect(foldRounds(feed, info)).toHaveLength(3);
  });
});

describe('the outcome of a review, in a few words', () => {
  it('names each state, and says a review in progress is in review', () => {
    expect(reviewOutcome('reviewing')).toBe('in review');
    expect(reviewOutcome('revising')).toBe('changes requested');
    expect(reviewOutcome('yours')).toBe('waiting for you');
    expect(reviewOutcome('approved')).toBe('approved');
  });
});
