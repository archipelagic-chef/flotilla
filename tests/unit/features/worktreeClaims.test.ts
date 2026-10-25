import { describe, expect, it } from 'vitest';
import {
  checkBranchWorktrees,
  checkCreating,
  checkReviewWorktree,
  CREATING_MAX_MS,
} from '../../../src/features/backlog/worktreeClaims';

const wt = (name: string, branch?: string) => ({ adminDir: `/repo/.git/worktrees/${name}`, path: `/repo/.worktrees/${name}`, branch });

describe('checkReviewWorktree', () => {
  const worktrees = [{ adminDir: '/repo/.git', path: '/repo' }, wt('a', 'feature/BL-1-a'), wt('b', 'feature/other')];
  const onTicket = (b: string) => b.startsWith('feature/BL-1-');

  it('claims nothing when the review names no worktree', () => {
    expect(checkReviewWorktree(undefined, worktrees, onTicket)).toBeUndefined();
  });

  it('holds for a worktree that is there, on the ticket’s branch', () => {
    const c = checkReviewWorktree('/repo/.git/worktrees/a', worktrees, onTicket);
    expect(c).toMatchObject({ ok: true, text: "Its review's worktree /repo/.worktrees/a is there, on feature/BL-1-a" });
    expect(c?.cleanup).toBeUndefined();
  });

  it('is a glitch when the worktree is gone, and Clean Up clears the review’s reference', () => {
    const c = checkReviewWorktree('/repo/.git/worktrees/gone', worktrees, onTicket);
    expect(c).toMatchObject({ ok: false, cleanup: { kind: 'review-worktree', worktree: '/repo/.git/worktrees/gone' } });
    expect(c?.text).toContain("there's no such worktree");
  });

  it('is a glitch when the worktree is on another branch, saying which', () => {
    const c = checkReviewWorktree('/repo/.git/worktrees/b', worktrees, onTicket);
    expect(c).toMatchObject({ ok: false, cleanup: { kind: 'review-worktree' } });
    expect(c?.text).toBe("Its review's worktree /repo/.worktrees/b is on feature/other, not on the ticket's branch");
  });

  it('says so for a detached one', () => {
    expect(checkReviewWorktree('/repo/.git', worktrees, onTicket)?.text).toContain('on no branch (detached)');
  });
});

describe('checkBranchWorktrees', () => {
  it('claims nothing for a worktree on disk; one deleted outside git is a glitch', () => {
    const claims = checkBranchWorktrees([wt('a', 'feature/a'), wt('b', 'feature/b')], (p) => p.endsWith('/a'));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ ok: false, key: 'worktree:/repo/.git/worktrees/b' });
    expect(claims[0].text).toContain('Worktree /repo/.worktrees/b of feature/b is gone from disk');
  });
});

describe('checkCreating', () => {
  const now = 1_000_000_000;
  const record = { id: 'BL-12', pid: 4812, host: 'box', at: now - 20_000 };
  const o = { dir: '/repo/.git/flotilla/creating', host: 'box', now };

  it('holds while the window creating it runs', () => {
    expect(checkCreating(record, { ...o, alive: () => true })).toMatchObject({ ok: true, text: 'Its worktree is being created (process 4812, for 20 s)' });
  });

  it('is a glitch when that window is gone, and Clean Up clears the record', () => {
    const c = checkCreating(record, { ...o, alive: () => false });
    expect(c).toMatchObject({ ok: false, cleanup: { kind: 'creating-stale', dir: o.dir, id: 'BL-12' } });
    expect(c.text).toContain('process 4812) is gone');
  });

  it('trusts another machine’s record, as its processes can’t be seen, until it’s too old', () => {
    const alive = () => false;
    expect(checkCreating({ ...record, host: 'other' }, { ...o, alive }).ok).toBe(true);
    const old = checkCreating({ ...record, host: 'other', at: now - CREATING_MAX_MS - 1 }, { ...o, alive });
    expect(old).toMatchObject({ ok: false, cleanup: { kind: 'creating-stale', id: 'BL-12' } });
  });

  it('is a glitch when a creation has run longer than any takes, even with its window running', () => {
    const c = checkCreating({ ...record, at: now - 20 * 60_000 }, { ...o, alive: () => true });
    expect(c.ok).toBe(false);
    expect(c.text).toContain('for 20 min');
  });
});
