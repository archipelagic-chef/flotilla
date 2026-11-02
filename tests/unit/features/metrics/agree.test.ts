import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  computeMetrics,
  EventIndex,
} from '../../../../src/features/metrics/compute';
import type {
  EventData,
  EventKind,
  FlotillaEvent,
} from '../../../../src/features/metrics/events';
import {
  metricDefs,
  metricsSummary,
} from '../../../../src/features/metrics/summary';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;

function ev<K extends EventKind>(t: number, kind: K, data: EventData[K], ticket?: string): FlotillaEvent<K> {
  return { at: new Date(t).toISOString(), kind, ...(ticket ? { ticket } : {}), data };
}

const region = (additions: boolean) => ({ start: 1, lines: 3, additions }) as never;
const tokens = (n: number) => ({ input: n, output: n / 2, cacheRead: 0, cacheCreation: 0 });
const spend = (t: number, purpose: EventData['agent-spend']['purpose'], usd: number, contextK: number[], ticket?: string) =>
  ev(t, 'agent-spend', { session: `s${t}`, purpose, to: new Date(t).toISOString(), tokens: tokens(4000), costUsd: usd, contextK, tools: {} }, ticket);
const ended = (t: number, usd: number, ticket?: string) =>
  ev(t, 'agent-ended', { role: 'work', session: `s${t}`, code: 0, ok: true, minutes: 30, costUsd: usd, tokens: tokens(2000) }, ticket);

/** A week of work and the week before it: merges with and without conflicts, checks failing, reviews, spend. */
function week(start: number, n: number): FlotillaEvent[] {
  const out: FlotillaEvent[] = [];
  for (let i = 0; i < n; i++) {
    const id = `BL-${start / D}-${i}`;
    const t = start + i * 8 * H;
    out.push(ev(t, 'ticket-moved', { from: 'todo', to: 'doing', by: 'Autopilot' }, id));
    out.push(spend(t + H, 'first', 1 + i, [20 + i * 10, 60], id));
    out.push(ended(t + H, 1 + i, id));
    if (i % 2) out.push(ev(t + 2 * H, 'review-verdict', { verdict: 'changes', round: 1, by: 'X' }, id));
    out.push(ev(t + 3 * H, 'review-verdict', { verdict: 'approved', round: 2, by: 'X' }, id));
    if (i % 3 === 0) out.push(ev(t + 4 * H, 'merge-conflicted', { files: [{ file: 'a.ts', regions: [region(true), region(i > 0)] } as never] }, id));
    if (i === 1) out.push(ev(t + 4 * H, 'merge-checks-failed', { tests: ['a'], failure: 'tests' } as never, id));
    if (i === 2) out.push(ev(t + 4 * H, 'merge-checks-failed', { tests: [], failure: 'timeout' } as never, id));
    // One ticket lands by being moved to Done, without a merge.
    if (i === n - 1) out.push(ev(t + 5 * H, 'ticket-moved', { from: 'review', to: 'done', by: 'You', criteria: 2 }, id));
    else out.push(ev(t + 5 * H, 'merge-landed', { into: 'main', commit: `c${i}` }, id));
    out.push(ev(t + 5 * H, 'ticket-moved', { from: 'review', to: 'done', by: 'Flotilla', criteria: 3 }, id));
  }
  out.push(spend(start + H, 'orchestration', 2, [90]));
  out.push(spend(start + 2 * H, 'rework', 1, [30], `BL-${start / D}-0`));
  return out;
}

const EVENTS = [...week(NOW - 13 * D, 4), ...week(NOW - 6 * D, 6)];

/** The view's numbers that the summary has too, by the summary's id, as the view rounds them. */
const SAME: Array<[view: string, summary: string, asView: (x: number) => number]> = [
  ['done', 'tickets-done', (x) => x],
  ['merges', 'merges', (x) => x],
  ['conflicted', 'conflicts-per-merge', (x) => Math.round(x * 100)],
  ['additions', 'additions-only-share', (x) => Math.round(x * 100)],
  ['checksFailed', 'checks-failed', (x) => x],
  ['checksTimedOut', 'check-timeouts', (x) => x],
  ['sentBack', 'sent-back', (x) => x],
  ['cost', 'cost-usd', (x) => x],
  ['tokens', 'tokens', (x) => x],
  ['criteriaPerUsd', 'criteria-per-usd', (x) => Math.round(x * 100) / 100],
  ['criteriaPerMTok', 'criteria-per-mtok', (x) => Math.round(x * 100) / 100],
  ['costPerTicket', 'cost-per-ticket', (x) => x],
  ['outsideTickets', 'spend-outside-tickets', (x) => Math.round(x * 100)],
  ['contextP50', 'context-median-k', (x) => x * 1000],
  ['contextP90', 'context-p90-k', (x) => x * 1000],
];

describe('the Metrics view and the improvement review (BL-265)', () => {
  it('count the numbers both show the same, for the same week and the one before', () => {
    const index = new EventIndex();
    index.add(EVENTS);
    const view = computeMetrics(index, 'week', NOW);
    const numbers = new Map(view.sections.flatMap((s) => s.numbers).map((n) => [n.id, n]));
    const summary = metricsSummary(EVENTS, { to: new Date(NOW), days: 7 });
    const metric = new Map(summary.metrics.map((m) => [m.id, m]));
    for (const [v, s, asView] of SAME) {
      const n = numbers.get(v)!;
      const m = metric.get(s)!;
      expect({ id: v, value: asView(m.value ?? 0), previous: asView(m.previous ?? 0) }).toEqual({ id: v, value: n.value, previous: n.previous });
    }
    // Not all zero: the log has something of each.
    expect(metric.get('tickets-done')).toMatchObject({ value: 6, previous: 4 });
    expect(metric.get('checks-failed')!.value).toBe(1);
  });

  it("keeps the ids the tickets' Improves: lines name", () => {
    const ids = metricDefs([]).map((d) => d.id);
    for (const id of ['merges-cancelled', 'limit-hours', 'limit-hits', 'lead-time-hours', 'check-failures-per-merge', 'conflicts-per-merge'])
      expect(ids).toContain(id);
  });
});
