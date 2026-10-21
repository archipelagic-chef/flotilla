import { describe, expect, it } from 'vitest';
import { checkCreating, checkNamedWorktrees, CREATING_MAX_MS } from '../../../src/features/backlog/worktreeClaims';

const wt = (path: string, branch?: string) => ({ path, recordedPath: path, branch: branch && `refs/heads/${branch}` });

describe('checkNamedWorktrees', () => {
  const worktrees = [wt('/repo'), wt('/repo/.worktrees/a', 'feature/a'), wt('/repo/.worktrees/b', 'feature/other')];

  it('holds for a worktree that is there, on its branch', () => {
    const [c] = checkNamedWorktrees([{ source: 'review', path: '/repo/.worktrees/a', branch: 'feature/a' }], worktrees);
    expect(c).toMatchObject({ ok: true, text: 'Worktree /repo/.worktrees/a is there, on feature/a' });
    expect(c.cleanup).toBeUndefined();
  });

  it('finds one by the path git recorded, from another environment', () => {
    const moved = [{ path: undefined, recordedPath: 'C:\\repo\\wt', branch: 'refs/heads/x' }];
    expect(checkNamedWorktrees([{ source: 'branch', path: 'C:\\repo\\wt', branch: 'x' }], moved)[0].ok).toBe(true);
  });

  it('is a glitch when the worktree is gone, and Clean Up clears the review’s reference', () => {
    const [c] = checkNamedWorktrees([{ source: 'review', path: '/repo/.worktrees/gone', branch: 'feature/g' }], worktrees);
    expect(c).toMatchObject({ ok: false, cleanup: { kind: 'review-worktree', path: '/repo/.worktrees/gone' } });
    expect(c.text).toContain('git has no worktree there');
  });

  it('is a glitch when the worktree is on another branch, saying which', () => {
    const [c] = checkNamedWorktrees([{ source: 'branch', path: '/repo/.worktrees/b', branch: 'feature/b' }], worktrees);
    expect(c.ok).toBe(false);
    expect(c.text).toBe("Worktree /repo/.worktrees/b should be on feature/b, but it's on feature/other");
    expect(c.cleanup).toBeUndefined();
  });

  it('says so for a detached worktree', () => {
    const [c] = checkNamedWorktrees([{ source: 'review', path: '/repo', branch: 'main' }], worktrees);
    expect(c.text).toContain('no branch (detached)');
  });
});

describe('checkCreating', () => {
  const now = 1_000_000_000;
  const record = { id: 'BL-12', pid: 4812, host: 'box', at: now - 20_000 };

  it('holds while the window creating it runs', () => {
    const c = checkCreating(record, { host: 'box', now, alive: () => true });
    expect(c).toMatchObject({ ok: true, text: 'Its worktree is being created (process 4812, for 20 s)' });
  });

  it('is a glitch when that window is gone, and Clean Up clears the record', () => {
    const c = checkCreating(record, { host: 'box', now, alive: () => false });
    expect(c).toMatchObject({ ok: false, cleanup: { kind: 'creating-stale', id: 'BL-12' } });
    expect(c.text).toContain('process 4812) is gone');
  });

  it('trusts another machine’s record, as its processes can’t be seen, until it’s too old', () => {
    const alive = () => false;
    expect(checkCreating({ ...record, host: 'other' }, { host: 'box', now, alive }).ok).toBe(true);
    const old = checkCreating({ ...record, host: 'other', at: now - CREATING_MAX_MS - 1 }, { host: 'box', now, alive });
    expect(old).toMatchObject({ ok: false, cleanup: { kind: 'creating-stale', id: 'BL-12' } });
  });

  it('is a glitch when a creation has run longer than any takes, even with its window running', () => {
    const c = checkCreating({ ...record, at: now - 20 * 60_000 }, { host: 'box', now, alive: () => true });
    expect(c.ok).toBe(false);
    expect(c.text).toContain('for 20 min');
  });
});
