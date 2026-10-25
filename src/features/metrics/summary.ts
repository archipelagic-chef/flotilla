import type { FlotillaEvent } from './events';
import { quantile } from './productivity';

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
  value(events: readonly FlotillaEvent[]): number | undefined;
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
 * it still has its lead time).
 */
export function metricDefs(all: readonly FlotillaEvent[], criteria: ReadonlyMap<string, number> = new Map()): MetricDef[] {
  const conflicted = (es: readonly FlotillaEvent[]) => of(es, 'merge-conflicted');
  const regions = (es: readonly FlotillaEvent[]) => conflicted(es).flatMap((e) => e.data.files.flatMap((f) => f.regions));
  const ended = (es: readonly FlotillaEvent[]) => of(es, 'agent-ended');
  const done = (es: readonly FlotillaEvent[]) => of(es, 'ticket-moved').filter((e) => e.data.to === 'done').length;
  // Productivity (BL-189): the acceptance criteria of the tickets done (as recorded then, else as their descriptions
  // have them now), for the chats' spend.
  const spend = (es: readonly FlotillaEvent[]) => of(es, 'agent-spend');
  const usd = (es: readonly FlotillaEvent[]) => sum(spend(es).map((e) => e.data.costUsd));
  const tokens = (es: readonly FlotillaEvent[]) =>
    sum(spend(es).map((e) => e.data.tokens.input + e.data.tokens.output + e.data.tokens.cacheRead + e.data.tokens.cacheCreation));
  const delivered = (es: readonly FlotillaEvent[]) => {
    const by = new Map<string, number>();
    for (const e of of(es, 'ticket-moved')) if (e.data.to === 'done' && e.ticket) by.set(e.ticket, e.data.criteria ?? criteria.get(e.ticket) ?? 0);
    return sum([...by.values()]);
  };
  const contexts = (es: readonly FlotillaEvent[]) =>
    spend(es)
      .flatMap((e) => e.data.contextK)
      .sort((a, b) => a - b);
  const ifSpent = (f: (es: readonly FlotillaEvent[]) => number | undefined) => (es: readonly FlotillaEvent[]) => (spend(es).length ? f(es) : undefined);
  // The tickets whose agents' runs were recorded live: the history read in has no cost, so a ratio of cost per ticket
  // counts only these (BL-178).
  const recorded = new Set(
    of(all, 'agent-ended')
      .filter((e) => !e.imported && e.ticket)
      .map((e) => e.ticket),
  );
  const doneRecorded = (es: readonly FlotillaEvent[]) =>
    new Set(
      of(es, 'ticket-moved')
        .filter((e) => e.data.to === 'done' && recorded.has(e.ticket))
        .map((e) => e.ticket),
    ).size;
  return [
    { id: 'criteria-per-usd', label: 'Acceptance criteria done per $ spent', better: 'higher', value: ifSpent((es) => ratio(delivered(es), usd(es))) },
    {
      id: 'criteria-per-mtok',
      label: 'Acceptance criteria done per million tokens',
      better: 'higher',
      value: ifSpent((es) => ratio(delivered(es), tokens(es) / 1e6)),
    },
    {
      id: 'spend-outside-tickets',
      label: 'Share of the spend in chats not tied to a ticket',
      better: 'lower',
      value: ifSpent((es) =>
        ratio(
          sum(
            spend(es)
              .filter((e) => e.data.purpose === 'orchestration')
              .map((e) => e.data.costUsd),
          ),
          usd(es),
        ),
      ),
    },
    {
      id: 'spend-rework-share',
      label: 'Share of the spend on rework, resuming and keeping up with main',
      better: 'lower',
      value: ifSpent((es) =>
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
    { id: 'context-median-k', label: 'Median context per turn (thousands of tokens)', better: 'lower', value: ifSpent((es) => quantile(contexts(es), 0.5)) },
    { id: 'context-p90-k', label: 'p90 context per turn (thousands of tokens)', better: 'lower', value: ifSpent((es) => quantile(contexts(es), 0.9)) },
    { id: 'tickets-done', label: 'Tickets done', better: 'higher', value: done },
    { id: 'lead-time-hours', label: 'Median hours from In Progress to Done', better: 'lower', unit: 'h', value: (es) => median(leadTimes(es, all)) },
    {
      id: 'changes-per-verdict',
      label: 'Reviews asking for changes, per verdict',
      better: 'lower',
      value: (es) => {
        const v = of(es, 'review-verdict');
        return ratio(v.filter((e) => e.data.verdict === 'changes').length, v.length);
      },
    },
    { id: 'merges', label: 'Merges landed', better: 'higher', value: (es) => of(es, 'merge-landed').length },
    {
      id: 'conflicts-per-merge',
      label: 'Merges that conflicted, per merge landed',
      better: 'lower',
      value: (es) => ratio(conflicted(es).length, of(es, 'merge-landed').length),
    },
    { id: 'conflict-regions', label: 'Conflicted regions', better: 'lower', value: (es) => regions(es).length },
    {
      id: 'additions-only-share',
      label: 'Conflicted regions where both sides only added lines',
      better: 'lower',
      value: (es) => ratio(regions(es).filter((r) => r.additions).length, regions(es).length),
    },
    {
      id: 'check-failures-per-merge',
      label: 'Merges whose checks failed, per merge landed',
      better: 'lower',
      value: (es) => ratio(of(es, 'merge-checks-failed').length, of(es, 'merge-landed').length),
    },
    {
      id: 'check-timeouts',
      label: 'Merge checks that timed out',
      better: 'lower',
      value: (es) => of(es, 'merge-checks-failed').filter((e) => e.data.failure === 'timeout').length,
    },
    { id: 'merges-cancelled', label: 'Merges cancelled', better: 'lower', value: (es) => of(es, 'merge-cancelled').length },
    { id: 'agent-runs', label: 'Agent runs started', better: 'lower', value: (es) => of(es, 'agent-started').length + of(es, 'agent-resumed').length },
    {
      id: 'agent-failures',
      label: 'Agent runs that ended in an error, per run ended',
      better: 'lower',
      value: (es) => ratio(ended(es).filter((e) => !e.data.ok).length, ended(es).length),
    },
    {
      id: 'agent-hours',
      label: 'Agent hours',
      better: 'lower',
      unit: 'h',
      value: (es) => (ended(es).length ? sum(ended(es).map((e) => e.data.minutes || 0)) / 60 : undefined),
    },
    {
      id: 'cost-usd',
      label: 'Agent cost',
      better: 'lower',
      unit: '$',
      value: (es) => (ended(es).some((e) => e.data.costUsd !== undefined) ? sum(ended(es).map((e) => e.data.costUsd ?? 0)) : undefined),
    },
    {
      id: 'cost-per-ticket',
      label: 'Agent cost per ticket done (of those whose agents were recorded)',
      better: 'lower',
      unit: '$',
      value: (es) =>
        ended(es).some((e) => e.data.costUsd !== undefined) ? ratio(sum(ended(es).map((e) => e.data.costUsd ?? 0)), doneRecorded(es)) : undefined,
    },
    { id: 'limit-hits', label: 'Usage limits hit', better: 'lower', value: (es) => of(es, 'limit-hit').length },
    {
      id: 'limit-hours',
      label: 'Hours waited for usage limits',
      better: 'lower',
      unit: 'h',
      value: (es) => sum(of(es, 'limit-lifted').map((e) => e.data.minutes ?? 0)) / 60,
    },
    { id: 'idle-stops', label: 'Times the autopilot stood idle with tickets waiting', better: 'lower', value: (es) => of(es, 'autopilot-idle').length },
    {
      id: 'test-wait-median-s',
      label: 'Median seconds a test run waited for its turn',
      better: 'lower',
      unit: 's',
      value: (es) => median(of(es, 'test-run').map((e) => e.data.waitMs / 1000)),
    },
    {
      id: 'click-wait-median-s',
      label: 'Median seconds a click waited',
      better: 'lower',
      unit: 's',
      value: (es) => median(of(es, 'click-waited').map((e) => e.data.ms / 1000)),
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
  const prev = eventsBetween(all, before, from);
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
      value: d.value(now),
      previous: d.value(prev),
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
