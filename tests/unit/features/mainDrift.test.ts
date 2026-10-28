import { describe, expect, it } from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import { reopenItem } from '../../../src/features/backlog/backlog';
import {
  baseLabel,
  branchesToCheck,
  conflictsOf,
  dependencyDiscardedEntry,
  dependsOn,
  discardedDeps,
  driftNotes,
  fileList,
  holdsUp,
  isOpen,
  type MainCheck,
  mergeBasePrompt,
  resumeWaits,
  reusable,
  waitChain,
  waitingFor,
  waitsOf,
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

  it("checks the ticket's branches that exist, at their heads", () => {
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
    expect(
      conflictsOf(
        item({
          mainCheck: check([
            ['x', []],
            ['y', ['a.ts']],
          ]),
        }),
      ).map((b) => b.branch),
    ).toEqual(['y']);
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

  it("doesn't wait for discarded ones, and waits again once they're reopened (BL-235)", () => {
    const discarded: BacklogData = {
      version: 1,
      next: 1,
      items: [
        item({ id: 'BL-2', status: 'todo', title: 'Two', discarded: { at: '2026-10-28T00:00:00Z' } }),
        item({ id: 'BL-3', status: 'review', title: 'Three' }),
      ],
    };
    expect(waitingFor(discarded, ['BL-2'])).toEqual([]);
    expect(discardedDeps(discarded, ['BL-2'])).toEqual([{ id: 'BL-2', title: 'Two' }]);
    expect(waitingFor(discarded, ['BL-2', 'BL-3'])).toEqual([{ id: 'BL-3', title: 'Three', status: 'review' }]);
    expect(discardedDeps(discarded, ['BL-2', 'BL-3'])).toEqual([{ id: 'BL-2', title: 'Two' }]);
    const reopened = reopenItem(discarded, 'BL-2');
    expect(waitingFor(reopened, ['BL-2', 'BL-3']).map((d) => d.id)).toEqual(['BL-2', 'BL-3']);
    expect(discardedDeps(reopened, ['BL-2', 'BL-3'])).toEqual([]);
  });

  it('tells a dependent that a ticket it depends on was discarded (BL-235)', () => {
    expect(dependencyDiscardedEntry('BL-172')).toBe(
      'BL-172, which this depends on, was discarded: it no longer waits for it. Check that it still makes sense without that work.',
    );
  });
});

describe('tickets a report waits for to be merged', () => {
  it('reads them from what the report says', () => {
    expect(resumeWaits('Needs from you: nothing. Resume me once BL-182 is merged.')).toEqual(['BL-182']);
    expect(resumeWaits('Pick it up after bl-135 merges.')).toEqual(['BL-135']);
    expect(resumeWaits('Resume me when BL-1 and BL-2 are merged, or once BL-3 has been merged.')).toEqual(['BL-1', 'BL-2', 'BL-3']);
    expect(resumeWaits('resume this ticket at least 7 days after BL-190 merges.')).toEqual(['BL-190']);
    expect(resumeWaits("Waiting for BL-182: its notes aren't on main yet.")).toEqual(['BL-182']);
  });

  it('ignores other mentions, and the ticket itself', () => {
    expect(resumeWaits('Builds on BL-12, like BL-13 did.')).toEqual([]);
    expect(resumeWaits('Resume me once BL-7 and BL-8 are merged.', 'bl-7')).toEqual(['BL-8']);
  });
});

describe('the tickets each one holds up (BL-238)', () => {
  const data: BacklogData = {
    version: 1,
    next: 1,
    items: [
      item({ id: 'BL-172', status: 'review' }),
      item({ id: 'BL-173', status: 'review' }),
      item({ id: 'BL-208', status: 'todo', notes: 'Depends on: BL-172' }),
      item({ id: 'BL-211', status: 'review', notes: 'Depends on: BL-173' }),
      item({ id: 'BL-213', status: 'todo', notes: 'Depends on: BL-211, BL-1' }),
      item({ id: 'BL-1', status: 'done' }),
      item({ id: 'BL-300', status: 'todo', notes: 'Depends on: BL-172', discarded: { at: '2026-10-20T00:00:00Z' } }),
      item({ id: 'BL-301', status: 'done', notes: 'Depends on: BL-173' }),
    ],
  };
  const read = async (i: BacklogItem) => i.notes ?? '';

  it("reads what each ticket not done waits for, from its description: done ones don't count", async () => {
    const waits = await waitsOf(data, read);
    expect(Object.fromEntries(waits)).toEqual({ 'BL-208': ['BL-172'], 'BL-211': ['BL-173'], 'BL-213': ['BL-211'], 'BL-300': ['BL-172'] });
  });

  it('holds up those that wait for it through a chain, and not discarded ones', async () => {
    const held = holdsUp(data, await waitsOf(data, read));
    expect(Object.fromEntries(held)).toEqual({ 'BL-172': ['BL-208'], 'BL-173': ['BL-211', 'BL-213'], 'BL-211': ['BL-213'] });
  });

  it('ends a loop of tickets that wait for each other, without holding itself up', () => {
    const waits = new Map([
      ['BL-1', ['BL-2']],
      ['BL-2', ['BL-1']],
    ]);
    expect(Object.fromEntries(holdsUp({ version: 1, next: 1, items: [] }, waits))).toEqual({ 'BL-1': ['BL-2'], 'BL-2': ['BL-1'] });
    expect(waitChain(waits, 'BL-1', (id) => id)).toBe('BL-2');
  });

  it('follows a chain to the ticket that holds it up', () => {
    const waits = new Map([
      ['BL-213', ['BL-211', 'BL-9']],
      ['BL-211', ['BL-173']],
    ]);
    expect(waitChain(waits, 'BL-213', (id) => `${id} (x)`)).toBe('BL-211, which waits for BL-173 (x), BL-9 (x)');
  });
});
