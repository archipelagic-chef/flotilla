import { describe, expect, it } from 'vitest';
import type { BacklogItem, BacklogStatus } from '../../../src/features/backlog/backlog';
import { needOf } from '../../../src/features/backlog/needs';
import type { ReviewState } from '../../../src/features/backlog/review';
import { turnOf, turnSentence, type Turn } from '../../../src/features/backlog/turn';
import { needsYouList } from '../../../src/features/needsYou';

const item = (status: BacklogStatus, review?: Partial<ReviewState>, over: Partial<BacklogItem> = {}): BacklogItem => ({
  id: 'BL-1',
  title: 'Thing',
  status,
  created: '2026-10-01T10:00:00.000Z',
  ...(review ? { review: { round: 2, state: 'reviewing', reviewer: 'Jet-6', implementer: 'Rune-3', ...review } } : {}),
  ...over,
});

const turn = (kind: Turn['kind'], who: string, mine: boolean): Turn => ({ kind, who, mine });

const paused = (phase: 'review' | 'work', agent: string, round = 2): Partial<ReviewState> => ({
  state: 'paused',
  round,
  paused: { until: 'T', known: true, phase, session: 's', agent, resume: phase === 'review' ? 'reviewing' : 'revising' },
});

describe('turnOf', () => {
  it('is the user’s when the work waits for their review, or for their approval after a reviewer agent’s', () => {
    expect(turnOf(item('review', { state: 'yours' }))).toEqual(turn('yours', 'You', true));
    expect(turnOf(item('review', { state: 'approved' }))).toEqual(turn('yours', 'You', true));
    expect(turnOf(item('review', { state: 'approved', byUser: true }))).toEqual(turn('yours', 'You', true));
  });

  it('is the user’s for an item in review that no reviewer agent is at', () => {
    expect(turnOf(item('review'))).toEqual(turn('yours', 'You', true));
    expect(turnOf(item('review', { state: 'working', round: 0 }))).toEqual(turn('yours', 'You', true));
  });

  it('is the reviewer’s while it reviews, or is about to', () => {
    expect(turnOf(item('review', { state: 'reviewing' }))).toEqual(turn('agent-review', 'Jet-6', false));
    expect(turnOf(item('review', { state: 'revising', reviewer: '' }))).toEqual(turn('agent-review', 'Agent', false));
  });

  it('is the implementer’s while it makes the changes asked for', () => {
    expect(turnOf(item('doing', { state: 'revising' }))).toEqual(turn('agent-revising', 'Rune-3', false));
  });

  it('stays the agent’s while it is paused on the usage limit', () => {
    expect(turnOf(item('review', paused('review', 'Jet-6')))).toEqual(turn('agent-review', 'Jet-6', false));
    expect(turnOf(item('doing', paused('work', 'Rune-3')))).toEqual(turn('agent-revising', 'Rune-3', false));
  });

  it('is the user’s to answer a question, or to decide how a stopped review goes on', () => {
    expect(turnOf(item('doing', { state: 'asking' }))).toEqual(turn('asking', 'You', true));
    expect(turnOf(item('review', { state: 'stopped', stop: { kind: 'rounds' } }))).toEqual(turn('stopped', 'You', true));
    expect(turnOf(item('review', { state: 'stopped', stop: { kind: 'user' } }))).toEqual(turn('stopped', 'You', true));
  });

  it('is nobody’s outside a review: done, proposed, not started, or at the first go', () => {
    expect(turnOf(item('done', { state: 'approved' }))).toBeUndefined();
    expect(turnOf(item('review', { state: 'yours' }, { proposed: { by: 'Jet-6' } }))).toBeUndefined();
    expect(turnOf(item('todo'))).toBeUndefined();
    expect(turnOf(item('doing', { state: 'working', round: 0 }))).toBeUndefined();
    expect(turnOf(item('doing', { state: 'revising', round: 0 }))).toBeUndefined();
    expect(turnOf(item('doing', paused('work', 'Rune-3', 0)))).toBeUndefined();
  });
});

describe('turnSentence', () => {
  const say = (i: BacklogItem) => turnSentence(turnOf(i)!, i.review);

  it('names the reviewer, the implementer and the round', () => {
    expect(say(item('review', { state: 'reviewing' })).text).toBe("Jet-6 reviews Rune-3's work, round 2.");
    expect(say(item('doing', { state: 'revising' })).text).toBe('Rune-3 makes the changes Jet-6 asked for, round 2.');
    expect(say(item('doing', { state: 'revising', byUser: true })).text).toBe('Rune-3 makes the changes you asked for, round 2.');
  });

  it('says what waits on the user, and what they can do', () => {
    expect(say(item('review', { state: 'yours' }))).toEqual({
      text: "Rune-3's work waits for your review, round 2.",
      todo: 'Approve it, or write what should change below and request changes.',
    });
    expect(say(item('review', { state: 'approved' })).text).toBe("Jet-6 approved Rune-3's work, round 2. It waits for your approval.");
    expect(say(item('review', { state: 'approved', byUser: true })).todo).toBe('Merge it, then move it to Done.');
    expect(say(item('review', { state: 'stopped', reason: 'no verdict.', stop: { kind: 'no-verdict' } })).text).toBe("The review of Rune-3's work stopped, round 2: no verdict.");
    expect(say(item('review', { state: 'stopped', stop: { kind: 'user' } })).text).toBe("You stopped the review of Rune-3's work, round 2.");
    expect(say(item('doing', { state: 'asking' })).todo).toMatch(/^Answer it/);
    expect(say(item('review')).text).toBe('The work waits for your review.');
  });
});

describe('the user’s turns and "Needs you"', () => {
  const states: Array<[BacklogStatus, Partial<ReviewState> | undefined]> = [
    ['review', undefined],
    ['review', { state: 'yours' }],
    ['review', { state: 'approved' }],
    ['review', { state: 'approved', byUser: true }],
    ['review', { state: 'reviewing' }],
    ['review', { state: 'revising' }],
    ['doing', { state: 'revising' }],
    ['doing', { state: 'asking' }],
    ['review', { state: 'stopped', stop: { kind: 'no-verdict' } }],
    ['review', { state: 'stopped', stop: { kind: 'user' } }],
    ['review', paused('review', 'Jet-6')],
    ['doing', { state: 'working', round: 0 }],
    ['done', { state: 'approved' }],
    ['todo', undefined],
  ];
  const items = states.map(([status, review], n) => item(status, review, { id: `BL-${n + 1}` }));

  it('lists exactly the items whose turn is the user’s', () => {
    for (const i of items) expect(!!needOf(i, []), `${i.id}: ${i.status} ${i.review?.state}`).toBe(!!turnOf(i)?.mine);
  });

  it('counts them for the badge', () => {
    expect(items.filter((i) => needOf(i, [])).length).toBe(7);
  });

  it('notifies about them, except what the user did themselves', () => {
    const notified = needsYouList(items, []).map((n) => n.ticket!.id);
    const mine = items.filter((i) => turnOf(i)?.mine).map((i) => i.id);
    expect(notified.every((id) => mine.includes(id))).toBe(true);
    expect(mine.filter((id) => !notified.includes(id)).sort()).toEqual(['BL-1', 'BL-10']);
  });
});

describe('agents the user paused or stopped (BL-81)', () => {
  const byUser = (phase: 'review' | 'work', agent: string): Partial<ReviewState> => ({
    state: 'paused',
    paused: { phase, session: 's', agent, resume: phase === 'review' ? 'reviewing' : 'working', byUser: '2026-10-18T10:00:00.000Z' },
  });

  it('is the user’s turn to resume a paused agent, at any stage of the work', () => {
    expect(turnOf(item('doing', { ...byUser('work', 'Rune-3'), round: 0 }))).toEqual(turn('paused', 'You', true));
    expect(turnOf(item('review', byUser('review', 'Jet-6')))).toEqual(turn('paused', 'You', true));
    expect(turnSentence(turn('paused', 'You', true), item('doing', byUser('work', 'Rune-3')).review).text).toBe('You paused Rune-3, round 2.');
    // Paused on a usage limit, it's still the agent's turn: it goes on by itself.
    expect(turnOf(item('review', paused('review', 'Jet-6')))?.mine).toBe(false);
  });

  it('lists paused and stopped agents in "Needs you", but sends no notice of what the user did', () => {
    const p = item('doing', byUser('work', 'Rune-3'));
    expect(needOf(p, [])).toMatchObject({ kind: 'stopped', line: 'You paused Rune-3' });
    const stopped = item('doing', { state: 'stopped', stop: { kind: 'user', agent: { phase: 'work', session: 's', agent: 'Rune-3', resume: 'working' } } });
    expect(needOf(stopped, [])).toMatchObject({ kind: 'stopped', line: 'You stopped Rune-3' });
    expect(turnSentence(turnOf(stopped)!, stopped.review).text).toBe('You stopped Rune-3, round 2.');
    expect(needsYouList([p, stopped], [])).toEqual([]);
  });
});
