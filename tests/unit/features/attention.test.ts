import { describe, expect, it } from 'vitest';
import { attentionTransitions, computeAttention, sortByAttention } from '../../../src/features/workstreams/attention';

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

describe('attentionTransitions', () => {
  it('reports keys that newly entered waiting-for-input or error', () => {
    const prev = new Map([
      ['a', 'working' as const],
      ['b', 'waiting-for-input' as const],
    ]);
    const next = [
      { key: 'a', attention: 'waiting-for-input' as const },
      { key: 'b', attention: 'waiting-for-input' as const },
      { key: 'c', attention: 'error' as const },
      { key: 'd', attention: 'done' as const },
    ];
    expect(attentionTransitions(prev, next)).toEqual(['a', 'c']);
  });

  it('reports nothing on the first refresh', () => {
    expect(attentionTransitions(undefined, [{ key: 'a', attention: 'error' }])).toEqual([]);
  });
});
