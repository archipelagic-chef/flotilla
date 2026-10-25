import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunBlock } from '../../../src/features/backlog/runBlocks';
import {
  demoPlace,
  planTerminal,
  runFingerprint,
  runPlaces,
  unknownNameMessage,
} from '../../../src/features/backlog/runWorktree';

const wt = (branch: string | undefined, path: string | undefined) => ({ branch, path, adminDir: `/repo/.git/worktrees/${branch ?? 'x'}` });

describe('the worktrees a run can use', () => {
  it('lists the reachable worktrees of the ticket, by branch', () => {
    const found = runPlaces(['feature/a', 'feature/b'], [wt('feature/a', '/w/a'), wt('feature/b', '/w/b')]);
    expect(found).toEqual({
      reachable: [
        { label: 'feature/a', dir: '/w/a' },
        { label: 'feature/b', dir: '/w/b' },
      ],
      unreachable: [],
      missing: [],
    });
  });

  it('says which worktree is in another environment (no folder here)', () => {
    const found = runPlaces(['feature/a'], [wt('feature/a', undefined)]);
    expect(found.reachable).toEqual([]);
    expect(found.unreachable).toEqual(['feature/a']);
    expect(found.missing).toEqual([]);
  });

  it('names the branches with no worktree (removed), and keeps the others', () => {
    const found = runPlaces(['feature/a', 'feature/gone'], [wt('feature/a', '/w/a')]);
    expect(found.reachable).toEqual([{ label: 'feature/a', dir: '/w/a' }]);
    expect(found.missing).toEqual(['feature/gone']);
  });

  it('labels a worktree without a branch by its admin dir', () => {
    const found = runPlaces([], [{ adminDir: '/repo/.git/worktrees/detached', path: '/w/d' }]);
    expect(found.reachable).toEqual([{ label: 'detached', dir: '/w/d' }]);
  });

  it('has nothing to run in when the ticket has no worktrees and no branches', () => {
    expect(runPlaces([], [])).toEqual({ reachable: [], unreachable: [], missing: [] });
  });
});

describe('the approval of a block', () => {
  const block: RunBlock = { kind: 'shell', title: 'Build', lines: ['npm run build'] };
  const dir = path.resolve('/w/a');

  it('is the same for the same block in the same worktree', () => {
    expect(runFingerprint('BL-3', dir, { ...block, lines: ['npm run build'] })).toBe(runFingerprint('BL-3', dir, block));
  });

  it('changes when the commands, the kind, the title, the worktree or the ticket change', () => {
    const fp = runFingerprint('BL-3', dir, block);
    expect(runFingerprint('BL-3', dir, { ...block, lines: ['npm run build', 'npm test'] })).not.toBe(fp);
    expect(runFingerprint('BL-3', dir, { ...block, kind: 'task' })).not.toBe(fp);
    expect(runFingerprint('BL-3', dir, { ...block, title: 'Test' })).not.toBe(fp);
    expect(runFingerprint('BL-3', path.resolve('/w/b'), block)).not.toBe(fp);
    expect(runFingerprint('BL-4', dir, block)).not.toBe(fp);
  });

  it('does not change for a title that is just absent versus empty', () => {
    expect(runFingerprint('BL-3', dir, { kind: 'shell', lines: ['x'] })).toBe(runFingerprint('BL-3', dir, { kind: 'shell', title: '', lines: ['x'] }));
  });
});

describe('a launch or task name that the worktree lacks', () => {
  const dir = path.resolve('/w/a');

  it('lists the names that exist', () => {
    expect(unknownNameMessage('launch', 'Nope', ['Run Extension', 'Debug tests'], dir)).toBe(
      `There's no launch configuration named "Nope" in ${dir}. Its launch configurations are: Run Extension, Debug tests.`,
    );
    expect(unknownNameMessage('task', 'lint', ['build'], dir)).toBe(`There's no task named "lint" in ${dir}. Its tasks are: build.`);
  });

  it('says when there are none', () => {
    expect(unknownNameMessage('task', 'lint', [], dir)).toBe(`There's no task named "lint" in ${dir}. It has no tasks.`);
  });

  it('says when the block has no name', () => {
    expect(unknownNameMessage('launch', undefined, ['A'], dir)).toBe("The launch block has no name: write the configuration's name after `launch`.");
    expect(unknownNameMessage('task', undefined, [], dir)).toBe("The task block has no name: write the task's name after `task`.");
  });
});

describe('the terminal of a run', () => {
  it('makes a new one when there is none', () => {
    expect(planTerminal('none')).toEqual({ action: 'new' });
  });

  it('reuses an idle one without asking', () => {
    expect(planTerminal('idle')).toEqual({ action: 'reuse' });
  });

  it('asks before stopping what runs there, and says so when that is known', () => {
    expect(planTerminal('running')).toEqual({ action: 'ask', known: true });
  });

  it('asks when shell integration is missing, and says it cannot tell', () => {
    expect(planTerminal('unknown')).toEqual({ action: 'ask', known: false });
  });
});

describe('demoPlace (BL-111)', () => {
  const main = { label: 'main', dir: '/repo' };
  const gone = { reachable: [], unreachable: [], missing: ['feature/x'] };

  it('runs a demo from main once its worktree is gone, when main has it', () => {
    expect(demoPlace(gone, 'demos/x.json', true, main)).toBe(main);
  });

  it("says why when main hasn't it", () => {
    expect(demoPlace(gone, 'demos/x.json', false, main)).toEqual({ why: expect.stringContaining("main doesn't have demos/x.json") });
  });

  it('leaves it to the worktree while there is one, here or elsewhere', () => {
    expect(demoPlace({ ...gone, reachable: [{ label: 'feature/x', dir: '/wt' }] }, 'demos/x.json', true, main)).toBeUndefined();
    expect(demoPlace({ ...gone, unreachable: ['feature/x'] }, 'demos/x.json', true, main)).toBeUndefined();
  });
});
