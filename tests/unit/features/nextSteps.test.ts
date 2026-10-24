import { describe, expect, it } from 'vitest';
import { nextSteps, stepLabel, type StepState } from '../../../src/features/backlog/nextSteps';

const approved: StepState = { status: 'review', canMerge: true, reviewing: true, hasRunBlock: true };

/** Each state, and the buttons it shows: the main one first. */
const table: Array<[string, StepState, string[], string?]> = [
  ['to do', { status: 'todo' }, ['Start an Agent']],
  ['an agent working on it', { status: 'doing', agentWorking: 'Rex-3' }, ['Open Chat', 'Stop'], 'Rex-3 is working on it'],
  [
    'in review with an agent reviewer working',
    { status: 'review', reviewing: true, reviewerWorking: 'Iris-3' },
    ['Open Chat', 'Review It Myself'],
    "Iris-3 reviews it: Approve and Request Changes come when it's done",
  ],
  ['yours to review', { status: 'review', reviewing: true, yours: true, hasRunBlock: true }, ['Approve', 'Request Changes', 'Run']],
  ['yours to review, without a run block', { status: 'review', reviewing: true, yours: true }, ['Approve', 'Request Changes', 'Ask for a Run Block']],
  ['approved', approved, ['Merge to main', 'Run']],
  [
    'branch conflicts with main',
    { ...approved, conflicts: ['a.ts', 'b.ts', 'c.ts'] },
    ['Update from Main and Merge', 'Run'],
    'Conflicts with main in 3 files: its agent resolves them, then it merges',
  ],
  ['CI red on the branch', { ...approved, ci: 'red' }, ['Fix CI with Agent', 'Run'], 'CI failed on its branch: an agent fixes it, then it can merge'],
  ['main moved since CI ran', { ...approved, ci: 'moved' }, ['Update from Main and Merge', 'Run'], 'Main moved since CI ran: it updates, CI runs again, then it merges'],
  ['in the merge queue', { ...approved, queue: { place: '2nd' } }, ['Merge Next', 'Remove from Queue', 'Run'], '2nd in the merge queue'],
  ['updating, then merging', { ...approved, chained: 'checks' }, [], 'Checks running…'],
  ['merged and done', { status: 'done', merged: true, hasWorktree: true }, ['Push…', 'Remove Its Worktree']],
  ['done, without a worktree', { status: 'done' }, []],
];

describe('nextSteps', () => {
  it.each(table)('%s', (_, state, buttons, status) => {
    const steps = nextSteps(state);
    expect([steps.main, ...steps.others].filter(Boolean).map((op) => stepLabel(op!))).toEqual(buttons);
    expect(steps.status).toBe(status);
  });

  it('never offers Start or Approve while an agent works, nor Merge on conflicts or red CI', () => {
    const ops = (s: StepState) => [nextSteps(s).main, ...nextSteps(s).others];
    expect(ops({ ...approved, yours: true, agentWorking: 'Rex-3' })).not.toContain('approve');
    expect(ops({ status: 'doing', agentWorking: 'Rex-3' })).not.toContain('start');
    expect(ops({ ...approved, conflicts: ['a.ts'] })).not.toContain('merge');
    expect(ops({ ...approved, ci: 'red' })).not.toContain('merge');
  });

  it("names the base it merges into", () => {
    expect(stepLabel('merge', 'develop')).toBe('Merge to develop');
    expect(stepLabel('updateAndMerge', 'develop')).toBe('Update from Develop and Merge');
  });
});
