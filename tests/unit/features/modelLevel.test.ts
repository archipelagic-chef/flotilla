import { describe, expect, it } from 'vitest';
import {
  asksStrongerModel,
  levelReport,
  movedUp,
  moveUpTarget,
  reviewModel,
  strongerRequest,
  weaker,
  workModel,
} from '../../../src/features/backlog/modelLevel';
import type { BacklogItem } from '../../../src/features/backlog/backlog';

const levels = { strong: 'opus', light: 'sonnet' };

describe('model levels', () => {
  it('runs work on the strong model unless the ticket is Light or chooses its own', () => {
    expect(workModel(undefined, levels)).toBe('opus');
    expect(workModel({ light: true }, levels)).toBe('sonnet');
    expect(workModel({ light: true }, { strong: 'opus' })).toBe('opus');
    expect(workModel({ model: 'haiku', light: true }, levels)).toBe('haiku');
  });

  it('never reviews on the light model', () => {
    expect(reviewModel({ light: true }, levels)).toBe('opus');
    expect(reviewModel({ light: true }, { ...levels, review: 'fable' })).toBe('fable');
    expect(reviewModel({ model: 'opus' }, { light: 'sonnet' })).toBe('opus');
  });

  it('moves up only from a known weaker model, never down or on a guess', () => {
    expect(moveUpTarget({ light: true }, levels)).toEqual({ from: 'sonnet', to: 'opus' });
    expect(moveUpTarget({ model: 'claude-haiku-5-5' }, levels)).toEqual({ from: 'claude-haiku-5-5', to: 'opus' });
    expect(moveUpTarget(undefined, levels)).toBeUndefined();
    expect(moveUpTarget({ model: 'opus' }, { strong: 'sonnet' })).toBeUndefined();
    expect(moveUpTarget({ model: 'fable' }, levels)).toBeUndefined();
    // Without a strong model set, Opus is where it moves.
    expect(moveUpTarget({ light: true }, { light: 'sonnet' })).toEqual({ from: 'sonnet', to: 'opus' });
    expect(weaker('opus', 'opus')).toBe(false);
  });

  it('keeps why it moved up, and drops Light', () => {
    const at = new Date('2026-10-17T12:00:00Z');
    expect(movedUp({ light: true, effort: 'high' }, { from: 'sonnet', to: 'opus' }, 'review round 2', at)).toEqual({
      effort: 'high',
      model: 'opus',
      movedUp: { from: 'sonnet', to: 'opus', reason: 'review round 2', at: at.toISOString() },
    });
  });

  it('sees a report asking for a stronger model, on a line of its own', () => {
    expect(asksStrongerModel('This needs a redesign of the queue.\n\nNeeds a stronger model.')).toBe(true);
    expect(asksStrongerModel('**Needs a stronger model.**')).toBe(true);
    expect(asksStrongerModel('Nobody here needs a stronger model. Ready for review.')).toBe(false);
  });

  it('takes the request only from the latest entry, by an agent, not seen before', () => {
    const report = { date: '2026-10-17 12:00', author: 'Agent Nova-7', body: 'Too subtle.\n\nNeeds a stronger model.' };
    const note = { date: '2026-10-17 12:01', author: 'Flotilla', body: 'Moved up.' };
    const key = (e: { date: string; author: string }) => `${e.date}|${e.author}`;
    expect(strongerRequest([report], [], key)).toEqual({ entry: report, agent: 'Nova-7' });
    expect(strongerRequest([report, note], [], key)).toBeUndefined();
    expect(strongerRequest([report], [key(report)], key)).toBeUndefined();
    expect(strongerRequest([{ ...report, author: 'You' }], [], key)).toBeUndefined();
  });

  it('reports finished tickets per level', () => {
    const item = (id: string, agent: BacklogItem['agent'], round: number): BacklogItem =>
      ({ id, title: id, status: 'done', created: '', updated: '', agent, review: { round, reviewer: 'R', state: 'approved' } }) as unknown as BacklogItem;
    const lines = levelReport(
      [
        item('BL-1', undefined, 1),
        item('BL-2', { light: true }, 1),
        item('BL-3', { model: 'opus', movedUp: { from: 'sonnet', to: 'opus', reason: 'R requested changes in review round 2', at: '' } }, 3),
        { ...item('BL-4', undefined, 1), status: 'doing' },
      ],
      levels,
    );
    expect(lines[0]).toBe('Model levels: 3 finished tickets.');
    expect(lines).toContain('  sonnet: 1 ticket, 1.0 review rounds on average (BL-2)');
    expect(lines).toContain('  moved up (sonnet → opus): 1 ticket, 3.0 review rounds on average (BL-3)');
    expect(lines.at(-1)).toBe('  BL-3 moved up: R requested changes in review round 2');
  });
});
