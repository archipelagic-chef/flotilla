import { describe, expect, it } from 'vitest';
import { vcTarget } from '../../../src/features/diffs/vcTarget';
import type { ChangeGroup, TicketChange } from '../../../src/features/diffs/ticketChange';

const file = (path: string) => ({ path, kind: 'modified' as const, added: 1, deleted: 0 });
const group = (g: Partial<ChangeGroup>): ChangeGroup => ({
  label: 'x',
  dir: '/repo',
  left: 'base',
  right: 'tip',
  compared: '',
  files: [file('a.ts')],
  added: 1,
  deleted: 0,
  uncommitted: 0,
  ...g,
});
const change = (stage: TicketChange['stage'], groups: ChangeGroup[]): TicketChange => ({ stage, groups, files: groups.length, added: 0, deleted: 0 });

describe('vcTarget (BL-173)', () => {
  const inWorktree = group({ dir: '/repo/.worktrees/b', right: 'WORKING', branch: 'feature/BL-1-b', files: [file('b.ts')] });
  const noWorktree = group({ branch: 'feature/BL-1-a', left: 'fork', right: 'tip' });

  it("opens the section on the first group in a worktree, on that worktree's Changes", () => {
    expect(vcTarget('BL-1', change('work', [noWorktree, inWorktree]))).toEqual({ kind: 'changes', dir: '/repo/.worktrees/b' });
  });

  it("opens a file in its own group's worktree, the file selected", () => {
    expect(vcTarget('BL-1', change('work', [noWorktree, inWorktree]), { group: 1, path: 'b.ts' })).toEqual({
      kind: 'changes',
      dir: '/repo/.worktrees/b',
      path: 'b.ts',
    });
  });

  it('compares a branch no worktree has from where it branched off', () => {
    expect(vcTarget('BL-1', change('work', [noWorktree]), { group: 0, path: 'a.ts' })).toEqual({
      kind: 'compare',
      base: 'fork',
      head: 'feature/BL-1-a',
      path: 'a.ts',
    });
  });

  it('compares a merged ticket on its merge commit, against its first parent', () => {
    expect(vcTarget('BL-1', change('merged', [group({ left: 'parent', right: 'merge' })]))).toEqual({ kind: 'compare', base: 'parent', head: 'merge' });
  });

  it("leads to main's history for its own commits on main, which are no one range", () => {
    expect(vcTarget('BL-1', change('commits', [group({})]))).toEqual({ kind: 'commits' });
  });

  it('leads to the history of the commits its Changes are narrowed to (BL-174)', () => {
    expect(vcTarget('BL-1', { ...change('picked', [group({})]), picked: ['c1', 'c2'] })).toEqual({ kind: 'commits', hashes: ['c1', 'c2'] });
  });

  it("says what it can't show", () => {
    expect(vcTarget('BL-1', change('none', []))).toEqual({ kind: 'none', why: 'BL-1 changes no files yet.' });
    expect(vcTarget('BL-1', change('work', [inWorktree]), { group: 0, path: 'gone.ts' })).toMatchObject({ kind: 'none' });
  });
});
