import { describe, expect, it } from 'vitest';
import type { BacklogStatus } from '../../../src/features/backlog/backlog';
import type { CardAgent } from '../../../src/features/backlog/cardAgents';
import { cardStatus, cardSummary, type CardStatusItem } from '../../../src/features/backlog/cardStatus';
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

  it('offers Accept on a proposal, and only its tracker’s status on an issue', () => {
    expect(line(item('todo', { proposed: { by: 'Nova-7' } }))).toEqual(['Proposed by Nova-7', '', '', 'Accept']);
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

describe('cardSummary', () => {
  it('sums up several agents and worktrees in one place', () => {
    expect(cardSummary(1, 1)).toBeUndefined();
    expect(cardSummary(2, 1)).toBe('2 agents');
    expect(cardSummary(2, 3)).toBe('2 agents · 3 worktrees');
  });
});
