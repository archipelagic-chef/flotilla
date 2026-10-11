import { describe, expect, it } from 'vitest';
import { IDLE_REFRESH_MS, isLive, isRebuildDue } from '../../../src/features/workstreams/refreshPlan';
import type { Workstream } from '../../../src/features/workstreams/workstream';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const POLL = 15_000;

function entry(overrides: Partial<Workstream> = {}): Workstream {
  return {
    key: '/r/.git/worktrees/a',
    agent: undefined,
    windowOpen: false,
    isCurrent: false,
    activity: 'idle',
    refreshedAt: NOW,
    ...overrides,
  } as Workstream;
}

describe('isLive', () => {
  it('counts a window, a running agent, recent changes, the sidebar pick or the current worktree', () => {
    expect(isLive(entry(), undefined)).toBe(false);
    expect(isLive(entry({ windowOpen: true }), undefined)).toBe(true);
    expect(isLive(entry({ isCurrent: true }), undefined)).toBe(true);
    expect(isLive(entry({ activity: 'active' }), undefined)).toBe(true);
    expect(isLive(entry({ agent: { state: 'working', updatedAt: new Date(NOW) } }), undefined)).toBe(true);
    expect(isLive(entry({ agent: { state: 'waiting-for-input', updatedAt: new Date(NOW) } }), undefined)).toBe(true);
    expect(isLive(entry({ agent: { state: 'done', updatedAt: new Date(NOW) } }), undefined)).toBe(false);
    expect(isLive(entry(), '/r/.git/worktrees/a')).toBe(true);
  });
});

describe('isRebuildDue', () => {
  it('builds what was never built, and everything for scope all', () => {
    expect(isRebuildDue(undefined, new Set(), NOW, POLL, undefined)).toBe(true);
    expect(isRebuildDue(entry(), 'all', NOW, POLL, undefined)).toBe(true);
  });

  it('builds the worktrees the scope names, whatever their schedule', () => {
    expect(isRebuildDue(entry(), new Set(['/r/.git/worktrees/a']), NOW, POLL, undefined)).toBe(true);
    expect(isRebuildDue(entry(), new Set(['/r/.git/worktrees/b']), NOW, POLL, undefined)).toBe(false);
  });

  it('rebuilds a live worktree every pollMs and an idle one every few minutes', () => {
    const live = entry({ windowOpen: true });
    const idle = entry({ activity: 'idle' });
    const later = (ms: number) => NOW + ms;
    expect(isRebuildDue(live, new Set(), later(10_000), POLL, undefined)).toBe(false);
    expect(isRebuildDue(live, new Set(), later(POLL), POLL, undefined)).toBe(true);
    expect(isRebuildDue(idle, new Set(), later(POLL), POLL, undefined)).toBe(false);
    expect(isRebuildDue(idle, new Set(), later(IDLE_REFRESH_MS - 1000), POLL, undefined)).toBe(true);
    expect(isRebuildDue(idle, new Set(), later(IDLE_REFRESH_MS - 2000), POLL, undefined)).toBe(false);
  });

  it('treats the sidebar pick as live', () => {
    expect(isRebuildDue(entry(), new Set(), NOW + POLL, POLL, '/r/.git/worktrees/a')).toBe(true);
  });
});
