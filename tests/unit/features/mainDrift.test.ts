import { describe, expect, it } from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import {
  baseLabel,
  branchesToCheck,
  conflictsOf,
  dependsOn,
  driftNotes,
  fileList,
  isOpen,
  mergeBasePrompt,
  reusable,
  waitingFor,
  type MainCheck,
} from '../../../src/features/backlog/mainDrift';

const item = (o: Partial<BacklogItem>): BacklogItem => ({ id: 'BL-1', title: 'T', status: 'doing', created: '2026-10-17T00:00:00Z', ...o });
const check = (branches: Array<[string, string[]]>, baseHead = 'b1'): MainCheck => ({
  base: 'main',
  baseHead,
  branches: branches.map(([branch, conflicts]) => ({ branch, head: `${branch}-head`, conflicts })),
});

describe('which branches are checked against main', () => {
  it('checks tickets being worked on or in review, not proposals, To Do or done', () => {
    expect(isOpen(item({ status: 'doing' }))).toBe(true);
    expect(isOpen(item({ status: 'review' }))).toBe(true);
    expect(isOpen(item({ status: 'todo' }))).toBe(false);
    expect(isOpen(item({ status: 'done' }))).toBe(false);
    expect(isOpen(item({ status: 'doing', proposed: {} }))).toBe(false);
  });

  it('checks the ticket\'s branches that exist, at their heads', () => {
    const heads = new Map([['feature/BL-1-a', 'c1']]);
    expect(branchesToCheck(item({ branches: ['feature/BL-1-a', 'feature/BL-1-gone'] }), heads)).toEqual([{ branch: 'feature/BL-1-a', head: 'c1' }]);
    expect(branchesToCheck(item({ branch: 'feature/BL-1-a' }), heads)).toEqual([{ branch: 'feature/BL-1-a', head: 'c1' }]);
  });

  it('reuses a check only of the same commits on both sides', () => {
    const prev = check([['x', ['a.ts']]]);
    expect(reusable(prev, 'b1', 'x', 'x-head')?.conflicts).toEqual(['a.ts']);
    expect(reusable(prev, 'b2', 'x', 'x-head')).toBeUndefined();
    expect(reusable(prev, 'b1', 'x', 'moved')).toBeUndefined();
    expect(reusable(undefined, 'b1', 'x', 'x-head')).toBeUndefined();
  });

  it('lists the branches that conflict', () => {
    expect(conflictsOf(item({ mainCheck: check([['x', []], ['y', ['a.ts']]]) })).map((b) => b.branch)).toEqual(['y']);
    expect(conflictsOf(item({}))).toEqual([]);
  });

  it("shows no conflicts for a ticket that isn't open any more (its check is stale)", () => {
    const mainCheck = check([['y', ['a.ts']]]);
    expect(conflictsOf(item({ status: 'done', mainCheck }))).toEqual([]);
    expect(conflictsOf(item({ status: 'todo', mainCheck }))).toEqual([]);
    expect(conflictsOf(item({ status: 'review', mainCheck }))).toHaveLength(1);
  });
});

describe('what the ticket says about it', () => {
  it('notes a branch that comes to conflict, and one that merges cleanly again', () => {
    const [conflict] = driftNotes(check([['x', []]]), check([['x', ['a.ts', 'b.ts']]], 'b2'));
    expect(conflict).toContain('`x` now conflicts with main (`a.ts`, `b.ts`)');
    expect(conflict).toContain('**Update from Main**');
    expect(driftNotes(check([['x', ['a.ts']]]), check([['x', []]], 'b2'))).toEqual(['Branch `x` merges cleanly with main again.']);
  });

  it('says nothing when nothing changes, or a first check finds no conflicts', () => {
    expect(driftNotes(undefined, check([['x', []]]))).toEqual([]);
    expect(driftNotes(check([['x', ['a.ts']]]), check([['x', ['a.ts', 'c.ts']]], 'b2'))).toEqual([]);
  });

  it('notes a first check that finds conflicts', () => {
    expect(driftNotes(undefined, check([['x', ['a.ts']]]))).toHaveLength(1);
  });

  it('names main as people say it', () => {
    expect(baseLabel('origin/main')).toBe('main');
    expect(baseLabel('main')).toBe('main');
    expect(baseLabel('develop')).toBe('develop');
    expect(fileList(['a', 'b', 'c', 'd', 'e'])).toBe('`a`, `b`, `c` and 2 more');
  });

  it('tells the agent to merge, resolve, check, commit with the id and report', () => {
    const prompt = mergeBasePrompt({ id: 'BL-1', base: 'origin/main', branch: 'feature/BL-1-x', files: ['a.ts'], ticket: '/t/BL-1.md' });
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).not.toContain('git merge');
    expect(prompt).toContain('in a.ts');
    expect(prompt).toContain('"BL-1: "');
    expect(prompt).toContain('Ready for review.');
  });
});

describe('tickets that depend on others', () => {
  it('reads "Depends on:" lines in the description', () => {
    expect(dependsOn('Do it.\n\nDepends on: BL-12, bl-13 and BL-14.\n')).toEqual(['BL-12', 'BL-13', 'BL-14']);
    expect(dependsOn('- **Depends on:** [BL-3](BL-3.md)')).toEqual(['BL-3']);
    expect(dependsOn('depends on BL-2')).toEqual(['BL-2']);
  });

  it('ignores mentions that aren\'t a "Depends on" line, and the ticket itself', () => {
    expect(dependsOn('This depends on BL-12 being fast.')).toEqual([]);
    expect(dependsOn('Depends on: BL-1, BL-2', 'BL-1')).toEqual(['BL-2']);
    expect(dependsOn('Depends on: nothing')).toEqual([]);
  });

  it('waits for those not done yet', () => {
    const data: BacklogData = {
      version: 1,
      next: 1,
      items: [item({ id: 'BL-2', status: 'done' }), item({ id: 'BL-3', status: 'review', title: 'Three' })],
    };
    expect(waitingFor(data, ['BL-2', 'BL-3', 'BL-99'])).toEqual([{ id: 'BL-3', title: 'Three', status: 'review' }]);
  });
});
