import { describe, expect, it } from 'vitest';
import { computeAttention, sortByAttention } from '../../../src/features/workstreams/attention';

const now = new Date('2026-10-09T10:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('computeAttention', () => {
  const base = { reachable: true, activity: 'idle' as const, now, agentStaleMinutes: 10 };

  it('uses the agent state when present', () => {
    expect(computeAttention({ ...base, agent: { state: 'waiting-for-input', updatedAt: minutesAgo(1) } })).toEqual({ state: 'waiting-for-input', agentStale: false });
  });

  it('falls back to activity when a working report is stale', () => {
    expect(computeAttention({ ...base, agent: { state: 'working', updatedAt: minutesAgo(11) } })).toEqual({ state: 'idle', agentStale: true });
  });

  it('keeps old waiting/done reports but flags them as stale', () => {
    expect(computeAttention({ ...base, agent: { state: 'waiting-for-input', updatedAt: minutesAgo(60) } })).toEqual({ state: 'waiting-for-input', agentStale: true });
  });

  it('uses activity without an agent and unreachable before anything else', () => {
    expect(computeAttention({ ...base, agent: undefined })).toEqual({ state: 'idle', agentStale: false });
    expect(computeAttention({ ...base, reachable: false, agent: { state: 'error', updatedAt: now } })).toEqual({ state: 'unreachable', agentStale: false });
  });
});

describe('sortByAttention', () => {
  it('orders by attention rank, then by most recent activity', () => {
    const items = [
      { name: 'idle', attention: 'idle' as const, lastActivity: minutesAgo(30) },
      { name: 'unreachable', attention: 'unreachable' as const },
      { name: 'working', attention: 'working' as const },
      { name: 'waiting', attention: 'waiting-for-input' as const },
      { name: 'active-old', attention: 'active' as const, lastActivity: minutesAgo(4) },
      { name: 'active-new', attention: 'active' as const, lastActivity: minutesAgo(1) },
    ];
    expect(sortByAttention(items).map((i) => i.name)).toEqual(['waiting', 'working', 'active-new', 'active-old', 'idle', 'unreachable']);
  });
});
