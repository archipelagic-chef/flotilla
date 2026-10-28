import { describe, expect, it } from 'vitest';
import type { BacklogData, BacklogItem } from '../../../src/features/backlog/backlog';
import type { TicketEntry } from '../../../src/features/backlog/ticket';
import {
  discardDetail,
  discardEntry,
  noteDependents,
  reopenEntry,
} from '../../../src/features/backlog/discard';

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

describe('noteDependents', () => {
  it('tells each open ticket that depends on the discarded one, once (BL-235)', async () => {
    const at = '2026-10-28T00:00:00Z';
    const item = (id: string, o: Partial<BacklogItem> = {}): BacklogItem => ({ id, title: id, status: 'todo', created: at, ...o });
    const data: BacklogData = {
      version: 1,
      next: 7,
      items: [
        item('BL-1', { discarded: { at } }),
        item('BL-2'),
        item('BL-3', { status: 'doing' }),
        item('BL-4', { status: 'done' }),
        item('BL-5', { discarded: { at } }),
        item('BL-6'),
      ],
    };
    const descriptions: Record<string, string> = {
      'BL-2': 'Depends on: BL-1',
      'BL-3': 'Depends on: BL-9, bl-1',
      'BL-4': 'Depends on: BL-1',
      'BL-5': 'Depends on: BL-1',
      'BL-6': 'Mentions BL-1, but depends on nothing.',
    };
    const appended: Array<[string, TicketEntry]> = [];
    await noteDependents(
      {
        read: async () => data,
        readTicketCached: async (i) => ({ description: descriptions[i.id] ?? '' }),
        appendActivity: async (i, e) => void appended.push([i.id, e]),
      },
      'BL-1',
      '2026-10-28 18:30',
    );
    const body = 'BL-1, which this depends on, was discarded: it no longer waits for it. Check that it still makes sense without that work.';
    expect(appended).toEqual([
      ['BL-2', { date: '2026-10-28 18:30', author: 'Flotilla', body }],
      ['BL-3', { date: '2026-10-28 18:30', author: 'Flotilla', body }],
    ]);
  });
});
