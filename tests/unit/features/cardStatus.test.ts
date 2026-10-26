import { describe, expect, it } from 'vitest';
import type { BacklogStatus } from '../../../src/features/backlog/backlog';
import type { CardAgent } from '../../../src/features/backlog/cardAgents';
import {
  cardStatus,
  type CardStatusItem,
  cardSummary,
  discardedLabel,
} from '../../../src/features/backlog/cardStatus';
import type { ReviewState } from '../../../src/features/backlog/review';

const item = (status: BacklogStatus, over: Partial<CardStatusItem> = {}): CardStatusItem => ({ status, ...over });
const review = (state: ReviewState['state'], over: Partial<ReviewState> = {}): ReviewState =>
  ({ round: 2, state, reviewer: 'Iris-3', implementer: 'Vega-2', ...over }) as ReviewState;
const agent = (name: string, over: Partial<CardAgent> = {}): CardAgent => ({ name, state: 'working', ...over });
const line = (i: CardStatusItem, agents: CardAgent[] = [], queued = false) => {
  const s = cardStatus(i, agents, queued);
  return [s.text, s.mark ?? '', s.working ? 'working' : '', s.next?.label ?? ''];
};

describe('cardStatus', () => {
  it("says an agent's reply to your comment came, until the ticket is opened (BL-127)", () => {
    expect(line(item('doing', { unseenReplies: 1 }), [agent('Vega-2')])).toEqual(['1 reply', 'question', '', 'Read']);
    expect(line(item('doing', { unseenReplies: 2 }))).toEqual(['2 replies', 'question', '', 'Read']);
    expect(line(item('doing', { unseenReplies: 'x' as never }))[0]).toBe('In progress · no agent on it');
  });

  it('says where an idle ticket is, with Start as its next step while it has no agent', () => {
    expect(line(item('todo'))).toEqual(['To do', '', '', 'Start']);
    expect(line(item('todo', { agent: { light: true } }))).toEqual(['To do · light', '', '', 'Start']);
    expect(line(item('doing'))).toEqual(['In progress · no agent on it', '', '', 'Start']);
    expect(line(item('done'))).toEqual(['Done', '', '', '']);
    expect(line(item('done', { merge: { base: 'main', state: 'merged', commits: 0, branches: [] } }))).toEqual(['Done · merged into main', '', '', '']);
  });

  it('says when a discarded ticket was discarded, with Reopen as its next step (BL-209)', () => {
    const at = '2026-10-26T06:40:00Z';
    expect(line(item('doing', { discarded: { at }, review: review('yours') }))).toEqual([discardedLabel(at), '', '', 'Reopen']);
    expect(discardedLabel(at)).toMatch(/^Discarded .*2026/);
  });

  it('offers Accept on a proposal, and only its tracker’s status on an issue', () => {
    expect(line(item('todo', { proposed: { by: 'Nova-7' } }))).toEqual(['Proposed by Nova-7 · waits to be accepted', '', '', 'Accept']);
    expect(line(item('todo', { source: { kind: 'jira', label: 'PROJ-4', url: 'u', statusName: 'In Progress' } }))).toEqual([
      'PROJ-4 · In Progress',
      '',
      '',
      '',
    ]);
  });

  it('names whose turn a review is, marking what waits for you', () => {
    expect(line(item('review', { review: review('reviewing') }))).toEqual(['In review · Iris-3 reviewing · 2 rounds', '', 'working', '']);
    expect(line(item('review', { review: review('reviewing', { round: 1 }) }))).toEqual(['In review · Iris-3 reviewing · 1 round', '', 'working', '']);
    expect(line(item('doing', { review: review('revising') }))).toEqual(['Revising · Vega-2 · round 2', '', 'working', '']);
    expect(line(item('review', { review: review('yours') }))).toEqual(['Waiting for you: review', 'question', '', 'Approve']);
    expect(line(item('doing', { review: review('asking') }))).toEqual(['Waiting for you: answer', 'question', '', 'Answer']);
    // Its agent stopped to go on later (BL-198): Resume, with what it waits for.
    const resume = (waits: string[], merged: string[]) => item('doing', { review: review('asking'), resume: { waits, merged } });
    expect(line(resume(['BL-182'], []))).toEqual(['Waits for BL-182 to be merged', '', '', 'Resume']);
    expect(line(resume([], ['BL-182']))).toEqual(['BL-182 is merged: resume it', 'question', '', 'Resume']);
    expect(line(resume([], []))).toEqual(['Waiting for you: resume it', 'question', '', 'Resume']);
    expect(line(item('review', { review: review('stopped') }))).toEqual(['Stopped: yours to decide', 'warning', '', 'Open']);
    expect(line(item('review', { review: review('paused', { paused: { byUser: 'You' } } as unknown as Partial<ReviewState>) }))).toEqual([
      'Paused',
      '',
      '',
      'Open',
    ]);
  });

  it('offers Merge once approved, and Merge Next behind others in the merge queue', () => {
    expect(line(item('review', { review: review('approved') }))).toEqual(['Approved by Iris-3 · ready to merge', '', '', 'Merge']);
    expect(line(item('review', { review: review('approved') }), [], true)).toEqual(['Approved · in the merge queue', '', '', 'Merge Next']);
  });

  it('shows a merge going on, and marks one that failed', () => {
    expect(line(item('review', { review: review('approved'), checks: { percent: 58 } }))).toEqual(['Merging: checks 58%', '', 'working', '']);
    expect(line(item('review', { checks: {} }))).toEqual(['Merging: checks', '', 'working', '']);
    const merging = (state: 'resolving' | 'resolved' | 'failed', reason?: string) =>
      ({ dir: 'd', branch: 'b', base: 'main', baseTip: 't', state, ...(reason ? { reason } : {}) }) as CardStatusItem['merging'];
    expect(line(item('review', { merging: merging('resolving') }))).toEqual(['Merging: an agent resolves its conflicts', '', 'working', '']);
    expect(line(item('review', { merging: merging('resolved') }))).toEqual(['Waiting for you: approve the merge', 'question', '', 'Open']);
    expect(line(item('review', { merging: merging('failed', 'checks failed: `npm test`') }))).toEqual([
      'Merge failed: checks failed: npm test',
      'error',
      '',
      'Open',
    ]);
  });

  it('marks the signs that need you before the work going on', () => {
    const working = [agent('Vega-2', { stuck: 'no output for 20 min' })];
    expect(line(item('doing'), working)).toEqual(['Vega-2 looks stuck: no output for 20 min', 'warning', '', 'Open']);
    const conflicts = { mainCheck: { base: 'main', baseHead: 'h', branches: [{ branch: 'feature/x', head: 'h', conflicts: ['a.ts'] }] } };
    expect(line(item('review', { ...conflicts, review: review('reviewing') }))).toEqual(['Conflicts with main', 'error', '', 'Open']);
    // Approved, Merge can't work on conflicts: Update and Merge does the job.
    expect(line(item('review', { ...conflicts, review: review('approved', { byUser: true }) }))).toEqual([
      'Conflicts with main in 1 file: its agent resolves them, then it merges',
      'error',
      '',
      'Update and Merge',
    ]);
    expect(line(item('done', { merge: { base: 'main', state: 'unmerged', commits: 2, branches: [] } }))).toEqual([
      "Done, but its work isn't merged",
      'warning',
      '',
      'Open',
    ]);
    expect(line(item('doing', { startFailed: { message: 'no worktree', since: 'T' } }))).toEqual(["Couldn't start: no worktree", 'error', '', 'Retry']);
    expect(line(item('doing'), [agent('Vega-2', { state: 'waiting' })])).toEqual(['Vega-2 waits for you', 'question', '', 'Answer']);
  });

  it('says what a working agent does, or why the ticket waits', () => {
    const activity = { tool: { name: 'Bash', input: 'npm test', since: '2026-10-24T10:00:00.000Z', done: true } } as unknown as CardAgent['activity'];
    const [text, mark, working] = line(item('doing'), [agent('Vega-2', { activity })]);
    expect(text).toMatch(/^Vega-2: /);
    expect([mark, working]).toEqual(['', 'working']);
    expect(line(item('doing'), [agent('Vega-2')])).toEqual(['Vega-2 working', '', 'working', '']);
    expect(line(item('doing'), [agent('Vega-2', { state: 'paused' })])).toEqual(['Vega-2 paused', '', '', '']);
    expect(line(item('todo', { clash: { with: 'BL-9', files: ['a.ts'] } }))).toEqual(['Held back until BL-9 is merged', '', '', '']);
    expect(line(item('todo', { waitsFor: ['BL-2', 'BL-5'] }))).toEqual(['Waits for BL-2, BL-5', '', '', '']);
    expect(line(item('todo', { creating: true }))).toEqual(['Creating its worktree…', '', 'working', '']);
  });
});

describe('cardStatus: a review start waiting for a free agent (BL-212)', () => {
  it('says it is queued for an agent review, with its place in line', () => {
    const queued = { kind: 'review' as const, reason: 'slot' as const, place: 2 };
    expect(line(item('review', { review: review('working', { round: 0, reviewer: '' }), queued }))).toEqual([
      'Queued for an agent review · 2nd in line',
      '',
      '',
      '',
    ]);
    expect(cardStatus(item('review', { queued: { ...queued, reason: 'memory' } }), []).tip).toBe("A reviewer agent takes it up when there's free memory.");
    // Its reviewer started, or the start was dropped: as before.
    expect(line(item('review', { review: review('reviewing'), queued }))[0]).toBe('In review · Iris-3 reviewing · 2 rounds');
    expect(line(item('review', { review: review('working', { round: 0 }) }))[0]).toBe('Waiting for you: review');
  });
});

describe('cardStatus: why the autopilot passes a To Do over (BL-205)', () => {
  const shaping = { agent: 'Astro-2', session: 's' };
  const tip = (i: CardStatusItem) => cardStatus(i, []).tip;

  it('says an epic is one, with its parts done, and offers no Start', () => {
    const epic = item('todo', { parts: { done: 3, total: 5 } });
    expect(line(epic)).toEqual(['Epic · 3 of 5 parts done', '', '', '']);
    expect(tip(epic)).toMatch(/takes its parts, not the epic/);
  });

  it('says a proposal waits to be accepted, or is discussed, before the autopilot takes it', () => {
    expect(tip(item('todo', { proposed: { by: 'Nova-7' } }))).toBe('The autopilot takes it once you accept it.');
    const discussed = item('todo', { proposed: { by: 'Nova-7' }, shaping });
    expect(line(discussed)).toEqual(['Proposed by Nova-7 · in discussion with Astro-2', '', '', 'Accept']);
    expect(tip(discussed)).toMatch(/ends the discussion/);
  });

  it('says a To Do in a discussion is, with whom, and that starting it ends it', () => {
    expect(line(item('todo', { shaping }))).toEqual(['In discussion with Astro-2', '', '', 'Start']);
    expect(tip(item('todo', { shaping }))).toMatch(/accepting it or starting it ends the discussion/);
    expect(line(item('doing', { shaping }))[0]).toBe('In progress · no agent on it');
  });

  it('says where each ticket it waits for stands', () => {
    const waits = item('todo', {
      waitsFor: ['BL-171', 'BL-5'],
      waitsOn: [
        { id: 'BL-171', standing: 'review stopped' },
        { id: 'BL-5', standing: 'in progress' },
      ],
    });
    expect(line(waits)).toEqual(['Waits for BL-171 (review stopped), BL-5 (in progress)', '', '', '']);
    expect(tip(waits)).toBe('The autopilot takes it once they are merged.');
  });
});

describe('cardSummary', () => {
  it('sums up several agents and worktrees in one place', () => {
    expect(cardSummary(1, 1)).toBeUndefined();
    expect(cardSummary(2, 1)).toBe('2 agents');
    expect(cardSummary(2, 3)).toBe('2 agents · 3 worktrees');
  });
});
