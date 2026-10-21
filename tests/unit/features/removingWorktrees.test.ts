import { describe, expect, it, vi } from 'vitest';
import { RemovingWorktrees } from '../../../src/features/workstreams/removingWorktrees';

describe('the worktrees being removed (BL-119)', () => {
  it('marks a worktree while it is removed, telling the views when it starts and ends', async () => {
    const removing = new RemovingWorktrees();
    const changed = vi.fn(() => seen.push(removing.has('a')));
    const seen: boolean[] = [];
    removing.onDidChange(changed);
    let done!: () => void;
    const run = removing.run('a', () => new Promise<void>((r) => (done = r)));
    expect(removing.has('a')).toBe(true);
    expect(removing.has('b')).toBe(false);

    done();
    await run;
    expect(removing.has('a')).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('unmarks it when the removal fails, and passes the failure on', async () => {
    const removing = new RemovingWorktrees();
    await expect(removing.run('a', async () => Promise.reject(new Error('locked')))).rejects.toThrow('locked');
    expect(removing.has('a')).toBe(false);
  });
});
