import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFresh, PENDING_TTL_MS, removalToRun, setupsToRun, withoutSetup, type PendingRemoval, type PendingSetup } from '../../../src/ui/pending';

const now = 1_800_000_000_000;
const root = path.resolve('/repo');
const wtA = path.join(root, '.worktrees', 'a');
const wtB = path.join(root, '.worktrees', 'b');

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

describe('setupsToRun', () => {
  it('runs fresh entries for this window, keeps fresh entries for others and drops stale ones', () => {
    const mine: PendingSetup = { worktreeDir: wtA, command: 'npm ci', createdAt: now - 1000 };
    const staleMine: PendingSetup = { worktreeDir: wtA, command: 'old', createdAt: now - PENDING_TTL_MS - 1 };
    const other: PendingSetup = { worktreeDir: wtB, command: 'npm ci', createdAt: now - 1000 };
    const staleOther: PendingSetup = { worktreeDir: wtB, command: 'old', createdAt: now - 3_600_000 };
    expect(setupsToRun([mine, staleMine, other, staleOther], wtA, now)).toEqual({ run: [mine], keep: [other] });
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

describe('withoutSetup', () => {
  it('removes the matching entry only', () => {
    const a: PendingSetup = { worktreeDir: wtA, command: 'npm ci', createdAt: now };
    const b: PendingSetup = { worktreeDir: wtB, command: 'npm ci', createdAt: now };
    expect(withoutSetup([a, b], { ...a })).toEqual([b]);
  });
});
