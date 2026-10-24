import { describe, expect, it } from 'vitest';
import { computeMetrics, EventIndex, idleKind, ticketFlow } from '../../../../src/features/metrics/compute';
import type { EventData, EventKind, FlotillaEvent } from '../../../../src/features/metrics/events';
import type { MetricsView } from '../../../../src/webview/metricsProtocol';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const H = 3_600_000;
const M = 60_000;
const D = 24 * H;

function ev<K extends EventKind>(t: number, kind: K, data: EventData[K], ticket?: string, agent?: string): FlotillaEvent<K> {
  return { at: new Date(t).toISOString(), kind, ...(ticket ? { ticket } : {}), ...(agent ? { agent } : {}), data };
}

const T0 = NOW - 3 * D;
const tokens = { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 };

/** A week's log: BL-1 goes from To Do to merged (with a conflict of additions only), BL-2 is sent back. */
const LOG: FlotillaEvent[] = [
  // The week before: BL-0 merged, cleanly.
  ev(NOW - 10 * D, 'merge-started', { into: 'main' }, 'BL-0'),
  ev(NOW - 10 * D + M, 'merge-landed', { into: 'main', commit: 'a' }, 'BL-0'),
  ev(T0, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, 'BL-1'),
  ev(T0, 'agent-started', { role: 'work', session: 's1' }, 'BL-1', 'Vega-2'),
  ev(T0 + 2 * H, 'agent-ended', { role: 'work', session: 's1', code: 0, ok: true, minutes: 120, tokens, costUsd: 1 }, 'BL-1', 'Vega-2'),
  ev(T0 + 2 * H, 'ticket-moved', { from: 'doing', to: 'review', by: 'Flotilla' }, 'BL-1'),
  ev(T0 + 2.5 * H, 'agent-started', { role: 'review', session: 's2' }, 'BL-1', 'Orbit-1'),
  ev(T0 + 3 * H, 'agent-ended', { role: 'review', session: 's2', code: 0, ok: true, minutes: 30, tokens, costUsd: 0.5 }, 'BL-1', 'Orbit-1'),
  ev(T0 + 3 * H, 'review-verdict', { verdict: 'approved', round: 1, by: 'Agent Orbit-1' }, 'BL-1'),
  ev(T0 + 3 * H, 'review-state', { from: 'reviewing', to: 'yours' }, 'BL-1'),
  ev(T0 + 4 * H, 'review-state', { from: 'yours', to: 'approved' }, 'BL-1'),
  ev(T0 + 4 * H + 10 * M, 'merge-started', { into: 'main' }, 'BL-1'),
  ev(T0 + 4 * H + 11 * M, 'merge-conflicted', { files: [{ file: 'src/a.ts', regions: [{ lines: 3, additions: true }] }] }, 'BL-1'),
  ev(T0 + 4.5 * H, 'merge-landed', { into: 'main', commit: 'b' }, 'BL-1'),
  ev(T0 + 4.5 * H, 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla' }, 'BL-1'),
  ev(NOW - 2 * D, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, 'BL-2'),
  ev(NOW - 2 * D, 'agent-started', { role: 'work', session: 's3' }, 'BL-2', 'Nova-7'),
  ev(NOW - 2 * D + H, 'agent-ended', { role: 'work', session: 's3', code: 0, ok: true, minutes: 60, tokens, costUsd: 2 }, 'BL-2', 'Nova-7'),
  ev(NOW - 2 * D + 2 * H, 'review-verdict', { verdict: 'changes', round: 1, by: 'Agent Orbit-1' }, 'BL-2'),
  ev(NOW - 2 * D + 3 * H, 'review-verdict', { verdict: 'approved', round: 2, by: 'Agent Orbit-1' }, 'BL-2'),
  ev(NOW - 2 * D + 4 * H, 'merge-started', { into: 'main' }, 'BL-2'),
  ev(NOW - 2 * D + 5 * H, 'merge-checks-failed', { failure: 'timeout', tests: ['tests/a.test.ts'] }, 'BL-2'),
  ev(NOW - 2 * D + 6 * H, 'merge-checks-failed', { failure: 'assertion', tests: [] }, 'BL-2'),
  ev(NOW - D, 'autopilot-idle', { reason: 'BL-5 waits for BL-2 (In Progress)' }),
  ev(NOW - H, 'click-waited', { button: 'backlog:approve', ms: 2400 }, 'BL-2'),
];

function view(log = LOG, period: 'day' | 'week' | 'month' = 'week'): MetricsView {
  const index = new EventIndex();
  index.add(log);
  return computeMetrics(index, period, NOW, { limit: 3 });
}

const num = (v: MetricsView, section: string, id: string) => v.sections.find((s) => s.id === section)!.numbers.find((n) => n.id === id)!;
const chart = (v: MetricsView, section: string, id: string) => v.sections.find((s) => s.id === section)!.charts.find((c) => c.id === id)!;

describe('ticketFlow', () => {
  it('splits a ticket\'s time from To Do to merged into its phases', () => {
    const index = new EventIndex();
    index.add(LOG);
    const flow = ticketFlow('BL-1', index.ticketEvents('BL-1'), NOW);
    expect(flow.end! - flow.start!).toBe(4.5 * H);
    expect(flow.phases).toEqual({ working: 2 * H, waitReview: 30 * M, review: 30 * M, you: 70 * M, merging: 20 * M });
    expect(flow.waits.map((w) => [w.kind, (w.to - w.from) / M])).toEqual([
      ['approve', 60],
      ['merge', 10],
    ]);
  });

  it('counts a ticket taken up again after it landed from its new start', () => {
    const index = new EventIndex();
    index.add([
      ...LOG,
      ev(NOW - D, 'ticket-moved', { from: 'done', to: 'doing', by: 'You' }, 'BL-1'),
      ev(NOW - D + H, 'merge-landed', { into: 'main', commit: 'c' }, 'BL-1'),
    ]);
    const flow = ticketFlow('BL-1', index.ticketEvents('BL-1'), NOW);
    expect([flow.start, flow.end]).toEqual([NOW - D, NOW - D + H]);
    expect(flow.phases.working).toBe(H);
  });

  it('reads the same in whatever order the events were added', () => {
    const index = new EventIndex();
    index.add([...LOG].reverse());
    expect(ticketFlow('BL-1', index.ticketEvents('BL-1'), NOW).phases.you).toBe(70 * M);
  });
});

describe('computeMetrics', () => {
  const v = view();

  it('counts the flow: tickets done and their time to merged', () => {
    expect(num(v, 'flow', 'done')).toMatchObject({ value: 1, previous: 1 });
    expect(num(v, 'flow', 'toMerged').value).toBe(270);
    expect(chart(v, 'flow', 'phases').bars.map((b) => [b.label, b.values[0]])).toEqual([
      ['Working', 120],
      ['Waiting for review', 30],
      ['In review', 30],
      ['Waiting for you', 70],
      ['Merging', 20],
    ]);
    expect(chart(v, 'flow', 'donePerDay').bars.flatMap((b) => b.rows.map((r) => r.ticket))).toEqual(['BL-1']);
    // BL-2 is in progress at the end of the week.
    expect(chart(v, 'flow', 'wip').bars.at(-1)!.values).toEqual([1, 0]);
  });

  it('counts the merges: conflict shares, pure additions, approval to landed, checks failing', () => {
    expect(num(v, 'merges', 'merges')).toMatchObject({ value: 1, previous: 1 });
    expect(num(v, 'merges', 'conflicted')).toMatchObject({ value: 100, previous: 0 });
    expect(num(v, 'merges', 'additions').value).toBe(100);
    expect(num(v, 'merges', 'approvalToLanded').value).toBe(30);
    expect(num(v, 'merges', 'checksTimedOut').value).toBe(1);
    expect(num(v, 'merges', 'checksFailed').value).toBe(1);
    expect(chart(v, 'merges', 'files').bars).toMatchObject([{ label: 'src/a.ts', values: [1] }]);
  });

  it('counts the agents: idle reasons, review rounds, tickets sent back', () => {
    const idle = chart(v, 'agents', 'idleWhy');
    expect(idle.bars.find((b) => b.label === 'Held back')!.values[0]).toBe(24 * 60);
    expect(num(v, 'agents', 'rounds').value).toBe(1.5);
    expect(num(v, 'agents', 'sentBack').rows).toMatchObject([{ ticket: 'BL-2' }]);
    expect(chart(v, 'agents', 'running').limit).toBe(3);
    expect(Math.max(...chart(v, 'agents', 'running').bars.map((b) => b.values[0]))).toBe(1);
  });

  it('counts a usage limit as idle time of its own', () => {
    const limited = view([ev(NOW - 3 * H, 'limit-hit', { limit: 'five-hour', until: new Date(NOW - 2 * H).toISOString() }), ev(NOW - H, 'agent-started', { role: 'work', session: 'x' }, 'BL-9')], 'day');
    expect(chart(limited, 'agents', 'idleWhy').bars.find((b) => b.label === 'Usage limit')!.values[0]).toBe(60);
  });

  it('counts the cost per role and the costliest tickets', () => {
    expect(num(v, 'cost', 'cost').value).toBe(3.5);
    expect(num(v, 'cost', 'tokens').value).toBe(4500);
    expect(chart(v, 'cost', 'costPerRole').bars.map((b) => b.values[0])).toEqual([3, 0.5, 0, 0]);
    expect(chart(v, 'cost', 'costliest').bars.map((b) => b.label)).toEqual(['BL-2', 'BL-1']);
  });

  it('counts the waits for you by kind, and the clicks that waited', () => {
    const waits = chart(v, 'you', 'waitsByKind');
    expect(waits.bars.find((b) => b.label === 'Approve')!.values[0]).toBe(60 + 60);
    expect(waits.bars.find((b) => b.label === 'Merge')!.values[0]).toBe(10);
    expect(num(v, 'you', 'slowClicks').rows).toMatchObject([{ label: 'backlog:approve', value: 2400 }]);
  });

  it('says why a chart is empty', () => {
    const empty = view([]);
    expect(chart(empty, 'merges', 'mergesPerDay')).toMatchObject({ empty: 'No merges this week' });
    expect(chart(empty, 'merges', 'mergesPerDay').bars.every((b) => b.values.every((x) => x === 0))).toBe(true);
  });

  it('stays fast with a year of events', () => {
    const log: FlotillaEvent[] = [];
    for (let i = 0; i < 150_000; i++) {
      const t = NOW - 365 * D + i * ((365 * D) / 150_000);
      const id = `BL-${Math.floor(i / 30)}`;
      const step = i % 30;
      if (step === 0) log.push(ev(t, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, id));
      else if (step === 1) log.push(ev(t, 'agent-started', { role: 'work', session: `s${i}` }, id, 'A'));
      else if (step === 10) log.push(ev(t, 'agent-ended', { role: 'work', session: `s${i - 9}`, code: 0, ok: true, minutes: 30, tokens, costUsd: 1 }, id, 'A'));
      else if (step === 29) log.push(ev(t, 'merge-landed', { into: 'main', commit: 'c' }, id));
      else log.push(ev(t, 'click-waited', { button: 'x', ms: 1000 + step }));
    }
    const index = new EventIndex();
    index.add(log);
    computeMetrics(index, 'month', NOW);
    const started = performance.now();
    for (const p of ['day', 'week', 'month'] as const) computeMetrics(index, p, NOW);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('idleKind', () => {
  it('reads why the autopilot is idle', () => {
    expect(idleKind('BL-5 waits for BL-2 (In Progress)')).toBe('held');
    expect(idleKind('1 merge failed (BL-3): it needs you')).toBe('you');
    expect(idleKind("BL-4 couldn't start: start it yourself")).toBe('you');
    expect(idleKind('nothing left in To Do')).toBe('nothing');
  });
});
