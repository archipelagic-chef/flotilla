import { describe, expect, it } from 'vitest';
import type { ResolvedWorktree } from '../../../src/features/worktrees/resolver';
import type { Workstream } from '../../../src/features/workstreams/workstream';
import { describeWorkstream, formatAge, workstreamContext, workstreamLabel } from '../../../src/ui/format';

const now = new Date('2026-10-09T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;

function makeWs(overrides: Partial<Workstream> = {}, wt: Partial<ResolvedWorktree> = {}): Workstream {
  return {
    key: '/r/.git/worktrees/a',
    worktree: {
      id: 'a',
      isMain: false,
      adminDir: '/r/.git/worktrees/a',
      path: '/r/.worktrees/a',
      recordedPath: '/r/.worktrees/a',
      branch: 'feat',
      head: undefined,
      locked: true,
      portable: true,
      insideRepo: true,
      ...wt,
    },
    changes: [],
    agent: undefined,
    agentStale: false,
    heartbeat: undefined,
    windowOpen: false,
    lastActivity: undefined,
    activity: 'idle',
    progress: undefined,
    attention: 'idle',
    isCurrent: false,
    ...overrides,
  };
}

describe('formatAge', () => {
  it.each([
    [30_000, '30s'],
    [5 * MIN, '5m'],
    [3 * 60 * MIN, '3h'],
    [2 * 24 * 60 * MIN, '2d'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatAge(ago(ms), now)).toBe(expected);
  });
  it('handles missing and future dates', () => {
    expect(formatAge(undefined, now)).toBe('—');
    expect(formatAge(new Date(now.getTime() + 5000), now)).toBe('0s');
  });
});

describe('describeWorkstream', () => {
  it('describes an agent waiting for input with progress and an open window', () => {
    const ws = makeWs({
      attention: 'waiting-for-input',
      agent: { state: 'waiting-for-input', updatedAt: ago(2 * MIN) },
      progress: { base: 'main', ahead: 3, behind: 0, added: 120, deleted: 40, lastSubject: 'x' },
      windowOpen: true,
      heartbeat: { env: 'container', os: 'linux', updatedAt: now },
    });
    expect(describeWorkstream(ws, now)).toBe('waiting for input · 2m · ↑3 +120 −40 · open in container');
  });

  it('describes the main worktree open in this window', () => {
    const ws = makeWs({ isCurrent: true, lastActivity: ago(3 * 60 * MIN) }, { isMain: true, id: undefined, branch: 'main' });
    expect(describeWorkstream(ws, now)).toBe('main worktree · idle · 3h · this window');
  });

  it('falls back to activity for a stale working report without saying "last reported"', () => {
    const ws = makeWs({ attention: 'idle', agentStale: true, agent: { state: 'working', updatedAt: ago(20 * MIN) }, lastActivity: ago(8 * MIN) });
    expect(describeWorkstream(ws, now)).toBe('idle · 8m');
  });

  it('marks old agent reports', () => {
    const ws = makeWs({ attention: 'waiting-for-input', agentStale: true, agent: { state: 'waiting-for-input', updatedAt: ago(60 * MIN) } });
    expect(describeWorkstream(ws, now)).toBe('waiting for input (last reported) · 1h');
  });

  it('describes unreachable worktrees', () => {
    expect(describeWorkstream(makeWs({ attention: 'unreachable' }, { path: undefined }), now)).toBe('unreachable from this environment');
  });
});

describe('labels and context values', () => {
  it('labels detached worktrees by short sha', () => {
    expect(workstreamLabel(makeWs({}, { branch: undefined, head: 'abcdef1234567' }))).toBe('detached @ abcdef1');
  });
  it('builds a context value usable in when-clauses', () => {
    expect(workstreamContext(makeWs())).toBe('workstream;reachable;notCurrent;linked;portable;noAgent;');
    expect(workstreamContext(makeWs({ isCurrent: true }, { isMain: true, path: '/r' }))).toBe('workstream;reachable;current;main;portable;noAgent;');
  });
});
