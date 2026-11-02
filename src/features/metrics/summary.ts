import type { FlotillaEvent } from './events';
import {
  count,
  EventIndex,
  spanNumbers,
} from './compute';
import {
  countProductivity,
  productivityNumbers,
} from './productivity';

/**
 * The numbers an improvement review is given (BL-159): each metric over a period, next to the period before it, so
 * the trend shows without the raw log. Each metric has a stable id: a proposal's `Improves:` line names it, and the
 * next review counts it again before and after the fix.
 */
export interface MetricDef {
  id: string;
  label: string;
  /** Which way is better. */
  better: 'lower' | 'higher';
  unit?: string;
  /** Its value over a span (milliseconds, from inclusive, to exclusive). */
  value(span: Span): number | undefined;
}

export interface Span {
  from: number;
  to: number;
}

export interface MetricValue {
  id: string;
  label: string;
  better: 'lower' | 'higher';
  unit?: string;
  value?: number;
  previous?: number;
}

export interface MetricsSummary {
  from: string;
  to: string;
  /** How many events the period had, and how many of them were read in from the history (imported). */
  events: number;
  imported: number;
  metrics: MetricValue[];
}

const DAY_MS = 86_400_000;

function of<K extends FlotillaEvent['kind']>(events: readonly FlotillaEvent[], kind: K): FlotillaEvent<K>[] {
  return events.filter((e): e is FlotillaEvent<K> => e.kind === kind);
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ratio(a: number, b: number): number | undefined {
  return b ? a / b : undefined;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** Hours from each ticket's first move to In Progress to its move to Done, for the tickets done in the events. */
function leadTimes(events: readonly FlotillaEvent[], all: readonly FlotillaEvent[]): number[] {
  const out: number[] = [];
  for (const done of of(events, 'ticket-moved').filter((e) => e.data.to === 'done' && e.ticket)) {
    const start = all.find(
      (e) => e.kind === 'ticket-moved' && e.ticket === done.ticket && (e as FlotillaEvent<'ticket-moved'>).data.to === 'doing' && e.at <= done.at,
    );
    if (start) out.push((Date.parse(done.at) - Date.parse(start.at)) / 3_600_000);
  }
  return out;
}

/**
 * The metrics, in the order a review reads them. `all` is every event (a ticket started before the period and done in
 * it still has its lead time). Those the Metrics view shows too are counted by its own counting (BL-265), for any span.
 */
export function metricDefs(all: readonly FlotillaEvent[], criteria: ReadonlyMap<string, number> = new Map()): MetricDef[] {
  const index = new EventIndex();
  index.add(all);
  // A span's counts, once per span however many metrics read them.
  const memo = <T>(f: (s: Span) => T) => {
    const cache = new Map<string, T>();
    return (s: Span) => {
      const key = `${s.from}-${s.to}`;
      if (!cache.has(key)) cache.set(key, f(s));
      return cache.get(key)!;
    };
  };
  const view = memo((s) => count(index, s, s.to));
  const prod = memo((s) => countProductivity(index, s, criteria));
  const events = memo((s) => index.between(s.from, s.to) as readonly FlotillaEvent[]);
  const on = (f: (es: readonly FlotillaEvent[]) => number | undefined) => (s: Span) => f(events(s));
  const conflicted = (es: readonly FlotillaEvent[]) => of(es, 'merge-conflicted');
  const regions = (es: readonly FlotillaEvent[]) => conflicted(es).flatMap((e) => e.data.files.flatMap((f) => f.regions));
  const ended = (es: readonly FlotillaEvent[]) => of(es, 'agent-ended');
  const spend = (es: readonly FlotillaEvent[]) => of(es, 'agent-spend');
  const usd = (es: readonly FlotillaEvent[]) => sum(spend(es).map((e) => e.data.costUsd));
  const k = (x: number | undefined) => (x === undefined ? undefined : x / 1000);
  return [
    { id: 'criteria-per-usd', label: 'Acceptance criteria done per $ spent', better: 'higher', value: (s) => productivityNumbers.criteriaPerUsd(prod(s)) },
    {
      id: 'criteria-per-mtok',
      label: 'Acceptance criteria done per million tokens',
      better: 'higher',
      value: (s) => productivityNumbers.criteriaPerMTok(prod(s)),
    },
    {
      id: 'spend-outside-tickets',
      label: 'Share of the spend in chats not tied to a ticket',
      better: 'lower',
      value: (s) => productivityNumbers.outsideTickets(prod(s)),
    },
    {
      id: 'spend-rework-share',
      label: 'Share of the spend on rework, resuming and keeping up with main',
      better: 'lower',
      value: on((es) =>
        ratio(
          sum(
            spend(es)
              .filter((e) => ['rework', 'resume', 'main'].includes(e.data.purpose))
              .map((e) => e.data.costUsd),
          ),
          usd(es),
        ),
      ),
    },
    {
      id: 'context-median-k',
      label: 'Median context per turn (thousands of tokens)',
      better: 'lower',
      value: (s) => k(productivityNumbers.contextP50(prod(s))),
    },
    { id: 'context-p90-k', label: 'p90 context per turn (thousands of tokens)', better: 'lower', value: (s) => k(productivityNumbers.contextP90(prod(s))) },
    { id: 'tickets-done', label: 'Tickets done (merged, or moved to Done)', better: 'higher', value: (s) => spanNumbers.done(view(s)) },
    { id: 'lead-time-hours', label: 'Median hours from In Progress to Done', better: 'lower', unit: 'h', value: on((es) => median(leadTimes(es, all))) },
    {
      id: 'changes-per-verdict',
      label: 'Reviews asking for changes, per verdict',
      better: 'lower',
      value: (s) => ratio(spanNumbers.sentBack(view(s)), of(events(s), 'review-verdict').length),
    },
    { id: 'sent-back', label: 'Tickets sent back by a review', better: 'lower', value: (s) => spanNumbers.sentBack(view(s)) },
    { id: 'merges', label: 'Merges landed', better: 'higher', value: (s) => spanNumbers.merges(view(s)) },
    {
      id: 'conflicts-per-merge',
      label: 'Merges that conflicted, per merge landed',
      better: 'lower',
      value: (s) => spanNumbers.conflicted(view(s)),
    },
    { id: 'conflict-regions', label: 'Conflicted regions', better: 'lower', value: on((es) => regions(es).length) },
    {
      id: 'additions-only-share',
      label: 'Conflicted merges where both sides only added lines, per merge that conflicted',
      better: 'lower',
      value: (s) => spanNumbers.additions(view(s)),
    },
    { id: 'checks-failed', label: 'Merge checks that failed (not timed out)', better: 'lower', value: (s) => spanNumbers.checksFailed(view(s)) },
    {
      id: 'check-failures-per-merge',
      label: 'Merge checks that failed (not timed out), per merge landed',
      better: 'lower',
      value: (s) => ratio(spanNumbers.checksFailed(view(s)), spanNumbers.merges(view(s))),
    },
    { id: 'check-timeouts', label: 'Merge checks that timed out', better: 'lower', value: (s) => spanNumbers.checksTimedOut(view(s)) },
    { id: 'merges-cancelled', label: 'Merges cancelled', better: 'lower', value: on((es) => of(es, 'merge-cancelled').length) },
    { id: 'agent-runs', label: 'Agent runs started', better: 'lower', value: on((es) => of(es, 'agent-started').length + of(es, 'agent-resumed').length) },
    {
      id: 'agent-failures',
      label: 'Agent runs that ended in an error, per run ended',
      better: 'lower',
      value: on((es) => ratio(ended(es).filter((e) => !e.data.ok).length, ended(es).length)),
    },
    {
      id: 'agent-hours',
      label: 'Agent hours',
      better: 'lower',
      unit: 'h',
      value: on((es) => (ended(es).length ? sum(ended(es).map((e) => e.data.minutes || 0)) / 60 : undefined)),
    },
    {
      id: 'cost-usd',
      label: 'Agent cost',
      better: 'lower',
      unit: '$',
      // The history read in has no cost: none at all is no number, not $0.
      value: (s) => (ended(events(s)).some((e) => e.data.costUsd !== undefined) ? spanNumbers.cost(view(s)) : undefined),
    },
    {
      id: 'tokens',
      label: 'Agent tokens',
      better: 'lower',
      value: (s) => (ended(events(s)).some((e) => e.data.tokens) ? spanNumbers.tokens(view(s)) : undefined),
    },
    {
      id: 'cost-per-ticket',
      label: "Agent cost per ticket done (of those whose agents' spend was recorded)",
      better: 'lower',
      unit: '$',
      value: (s) => productivityNumbers.costPerTicket(prod(s)),
    },
    { id: 'limit-hits', label: 'Usage limits hit', better: 'lower', value: on((es) => of(es, 'limit-hit').length) },
    {
      id: 'limit-hours',
      label: 'Hours waited for usage limits',
      better: 'lower',
      unit: 'h',
      value: on((es) => sum(of(es, 'limit-lifted').map((e) => e.data.minutes ?? 0)) / 60),
    },
    { id: 'idle-stops', label: 'Times the autopilot stood idle with tickets waiting', better: 'lower', value: on((es) => of(es, 'autopilot-idle').length) },
    {
      id: 'test-wait-median-s',
      label: 'Median seconds a test run waited for its turn',
      better: 'lower',
      unit: 's',
      value: on((es) => median(of(es, 'test-run').map((e) => e.data.waitMs / 1000))),
    },
    {
      id: 'click-wait-median-s',
      label: 'Median seconds a click waited',
      better: 'lower',
      unit: 's',
      value: on((es) => median(of(es, 'click-waited').map((e) => e.data.ms / 1000))),
    },
  ];
}

/** The events from (inclusive) to (exclusive). */
export function eventsBetween(events: readonly FlotillaEvent[], from: Date, to: Date): FlotillaEvent[] {
  const a = from.toISOString();
  const b = to.toISOString();
  return events.filter((e) => e.at >= a && e.at < b);
}

/** The metrics of the `days` before `to`, each next to the same span before it. */
export function metricsSummary(all: readonly FlotillaEvent[], o: { to: Date; days: number; criteria?: ReadonlyMap<string, number> }): MetricsSummary {
  const from = new Date(o.to.getTime() - o.days * DAY_MS);
  const before = new Date(from.getTime() - o.days * DAY_MS);
  const now = eventsBetween(all, from, o.to);
  return {
    from: from.toISOString(),
    to: o.to.toISOString(),
    events: now.length,
    imported: now.filter((e) => e.imported).length,
    metrics: metricDefs(all, o.criteria).map((d) => ({
      id: d.id,
      label: d.label,
      better: d.better,
      unit: d.unit,
      value: d.value({ from: from.getTime(), to: o.to.getTime() }),
      previous: d.value({ from: before.getTime(), to: from.getTime() }),
    })),
  };
}

/** A metric's value, rounded for reading: money to cents, the rest to two decimals at most. */
export function formatValue(v: number | undefined, unit?: string): string {
  if (v === undefined || Number.isNaN(v)) return '–';
  const n = Math.round(v * 100) / 100;
  return unit === '$' ? `$${n.toFixed(2)}` : `${n}${unit && unit !== '$' ? ` ${unit}` : ''}`;
}

/** Which way a metric went: better, worse or the same (or nothing to compare). */
export function trend(m: Pick<MetricValue, 'value' | 'previous' | 'better'>): 'better' | 'worse' | 'same' | undefined {
  if (m.value === undefined || m.previous === undefined) return undefined;
  if (Math.abs(m.value - m.previous) < 1e-9) return 'same';
  return m.value < m.previous === (m.better === 'lower') ? 'better' : 'worse';
}

/** The summary as a Markdown table, for the review's prompt and its page. */
export function summaryMarkdown(s: MetricsSummary): string {
  const day = (iso: string) => iso.slice(0, 10);
  const arrow = { better: '↑ better', worse: '↓ worse', same: '= same' } as const;
  return [
    `Period ${day(s.from)} to ${day(s.to)} (${s.events} events${s.imported ? `, ${s.imported} read in from the history` : ''}), next to the period before it.`,
    '',
    '| Metric (id) | This period | Before | Trend |',
    '| --- | --- | --- | --- |',
    ...s.metrics.map((m) => {
      const t = trend(m);
      return `| ${m.label} (\`${m.id}\`, ${m.better} is better) | ${formatValue(m.value, m.unit)} | ${formatValue(m.previous, m.unit)} | ${t ? arrow[t] : ''} |`;
    }),
  ].join('\n');
}
