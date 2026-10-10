import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFresh, PENDING_TTL_MS, removalToRun, type PendingRemoval } from '../../../src/ui/pending';

const now = 1_800_000_000_000;
const root = path.resolve('/repo');
const wtA = path.join(root, '.worktrees', 'a');

const removal = (createdAt: number, mainRoot = root): PendingRemoval => ({
  mainRoot,
  adminDir: path.join(root, '.git', 'worktrees', 'a'),
  force: true,
  deleteBranch: true,
  branch: 'a',
  createdAt,
});

describe('isFresh', () => {
  it('accepts entries up to two minutes old', () => {
    expect(PENDING_TTL_MS).toBe(120_000);
    expect(isFresh({ createdAt: now }, now)).toBe(true);
    expect(isFresh({ createdAt: now - PENDING_TTL_MS }, now)).toBe(true);
  });

  it('rejects older, future-dated and legacy entries without createdAt', () => {
    expect(isFresh({ createdAt: now - PENDING_TTL_MS - 1 }, now)).toBe(false);
    expect(isFresh({ createdAt: now + 60_000 }, now)).toBe(false);
    expect(isFresh({}, now)).toBe(false);
    expect(isFresh({ createdAt: 'yesterday' }, now)).toBe(false);
  });
});

describe('removalToRun', () => {
  it('runs a fresh removal in the main worktree window of the same repo', () => {
    expect(removalToRun(removal(now - 1000), root, root, now)).toEqual({ run: removal(now - 1000), clear: true });
  });

  it('drops a stale removal without running it', () => {
    expect(removalToRun(removal(now - PENDING_TTL_MS - 1), root, root, now)).toEqual({ run: undefined, clear: true });
    expect(removalToRun({ ...removal(now), createdAt: undefined } as unknown as PendingRemoval, root, root, now)).toEqual({ run: undefined, clear: true });
  });

  it('leaves a fresh removal for another window alone', () => {
    expect(removalToRun(removal(now - 1000), root, wtA, now)).toEqual({ run: undefined, clear: false });
    expect(removalToRun(removal(now - 1000, path.resolve('/other')), root, root, now)).toEqual({ run: undefined, clear: false });
    expect(removalToRun(undefined, root, root, now)).toEqual({ run: undefined, clear: false });
  });
});
