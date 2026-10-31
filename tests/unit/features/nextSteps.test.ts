import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  nextSteps,
  stepLabel,
  type StepState,
} from '../../../src/features/backlog/nextSteps';

const approved: StepState = { status: 'review', canMerge: true, reviewing: true, hasRunBlock: true };

/** Each state, and the buttons it shows: the main one first. */
const table: Array<[string, StepState, string[], string?]> = [
  ['to do', { status: 'todo' }, ['Start an Agent']],
  ['its agent stopped to go on later, naming no ticket', { status: 'doing', asking: { waits: [], merged: [] } }, ['Resume', 'Start an Agent']],
  [
    "its agent waits for a ticket that isn't merged",
    { status: 'doing', asking: { waits: ['BL-182'], merged: [] } },
    ['Resume', 'Start an Agent'],
    'Waits for BL-182 to be merged',
  ],
  [
    'its agent waits for tickets that are all merged',
    { status: 'doing', asking: { waits: [], merged: ['BL-182', 'BL-183'] } },
    ['Resume', 'Start an Agent'],
    'BL-182 and BL-183 are merged: resume it',
  ],
  [
    'its agent waits for two tickets, one merged',
    { status: 'review', reviewing: true, hasRunBlock: true, asking: { waits: ['BL-183'], merged: ['BL-182'] } },
    ['Resume', 'Start an Agent', 'Run'],
    'Waits for BL-183 to be merged',
  ],
  ['an agent working on it', { status: 'doing', agentWorking: 'Rex-3' }, ['Open Chat', 'Stop'], 'Rex-3 is working on it'],
  [
    'in review with an agent reviewer working',
    { status: 'review', reviewing: true, reviewerWorking: 'Iris-3' },
    ['Open Chat', 'Review It Myself'],
    "Iris-3 reviews it: Approve and Request Changes come when it's done",
  ],
  [
    'in review, its reviewer agent queued (BL-212)',
    { status: 'review', reviewing: true, reviewQueued: true, agentWorking: 'Pip-3', hasRunBlock: true },
    ['Review It Myself', 'Run'],
    'Approve and Request Changes come when its review is done',
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
  [
    'main moved since CI ran',
    { ...approved, ci: 'moved' },
    ['Update from Main and Merge', 'Run'],
    'Main moved since CI ran: it updates, CI runs again, then it merges',
  ],
  [
    'in the merge queue, behind others',
    { ...approved, queue: { place: '2nd', ahead: 1 } },
    ['Merge Next', 'Merge to main', 'Remove from Queue', 'Run'],
    '2nd in the merge queue',
  ],
  ['first in the merge queue', { ...approved, queue: { place: '1st', ahead: 0 } }, ['Merge to main', 'Remove from Queue', 'Run'], '1st in the merge queue'],
  ['updating, then merging', { ...approved, chained: 'checks' }, [], 'Checks running…'],
  [
    'updating, its agent resolving',
    { ...approved, chained: 'resolving', agentWorking: 'Rex-3' },
    ['Open Chat', 'Stop'],
    'Updating from main: its agent resolves the conflicts…',
  ],
  [
    'updating, its resolution yours to approve',
    { ...approved, canMerge: false, yours: true, chained: 'resolving' },
    ['Approve', 'Request Changes', 'Run'],
    'Updating from main: its agent resolves the conflicts… It merges once you approve',
  ],
  ['merged and done', { status: 'done', merged: true, unpushed: true, hasWorktree: true }, ['Push…', 'Remove Its Worktree…']],
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

  it('offers no Start on an epic in progress: its parts are worked on (BL-239)', () => {
    expect(nextSteps({ status: 'doing', epicStarted: true })).toEqual({
      others: [],
      status: 'Its parts are worked on, not the epic: it moves to Done with the last of them',
    });
  });

  it('names the base it merges into', () => {
    expect(stepLabel('merge', 'develop')).toBe('Merge to develop');
    expect(stepLabel('updateAndMerge', 'develop')).toBe('Update from Develop and Merge');
  });
});
