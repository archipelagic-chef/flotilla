import { describe, expect, it } from 'vitest';
import { discardDetail, discardEntry, reopenEntry } from '../../../src/features/backlog/discard';

describe('discardDetail', () => {
  it("is BL-209's plain confirmation when nothing has started", () => {
    expect(discardDetail({ agents: [], worktrees: [] })).toBe(
      'It leaves the lanes; its ticket and activity are kept, and you can reopen it from the Discarded section.',
    );
  });

  it('names the agents that stop and the worktrees that go, warning about uncommitted files', () => {
    const detail = discardDetail({
      agents: ['Mica-5'],
      worktrees: [
        { label: 'BL-7-a', changedFiles: 3 },
        { label: 'BL-7-b', changedFiles: 0 },
      ],
    });
    expect(detail).toContain('Its agent stops: Mica-5.');
    expect(detail).toContain('Its worktrees are removed, keeping the branch: BL-7-a, BL-7-b.');
    expect(detail).toContain('BL-7-a: 3 uncommitted or untracked file(s) will be deleted.');
    expect(detail).not.toContain('BL-7-b: 0');
  });
});

describe('discardEntry', () => {
  it('lists what stopped, what went, the kept branches and what was left', () => {
    const body = discardEntry({
      stopped: ['Mica-5'],
      removed: ['feature/BL-7-a'],
      removing: 'feature/BL-7-b',
      branches: ['feature/BL-7-a', 'feature/BL-7-b'],
      left: ["Opal-2 works in Claude Code's panel"],
    })!;
    expect(body).toContain('Discarding it stopped Mica-5.');
    expect(body).toContain('It removed the worktree of `feature/BL-7-a`.');
    expect(body).toContain('The worktree of `feature/BL-7-b` is removed as this window opens the main worktree.');
    expect(body).toContain('Its branches stay: `feature/BL-7-a`, `feature/BL-7-b`.');
    expect(body).toContain("Left as it was:\n- Opal-2 works in Claude Code's panel");
  });

  it('says nothing when nothing had started', () => {
    expect(discardEntry({ stopped: [], removed: [], branches: [], left: [] })).toBeUndefined();
  });
});

describe('reopenEntry', () => {
  it('names the branches still there, or nothing', () => {
    expect(reopenEntry(['feature/BL-7-a'])).toBe('Its branch from before is still there: `feature/BL-7-a`. Start picks the work up there again.');
    expect(reopenEntry([])).toBeUndefined();
  });
});
