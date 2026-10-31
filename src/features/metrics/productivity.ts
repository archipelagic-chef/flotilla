import type {
  MetricBar,
  MetricNumber,
  MetricRow,
  MetricSection,
  MetricsPeriod,
} from '../../webview/metricsProtocol';
import type {
  EventKind,
  FlotillaEvent,
} from './events';
import {
  PURPOSE_LABEL,
  SPEND_PURPOSES,
  type SpendPurpose,
  TOOL_KINDS,
  TOOL_LABEL,
  type ToolKind,
} from './transcriptSpend';

/**
 * Productivity per token (BL-189): the acceptance criteria of the tickets done, for what was spent, and where the spend
 * went (counted from the agent-spend events of the chats' transcripts).
 */

type Ev<K extends EventKind = EventKind> = FlotillaEvent<K> & { t: number };
type Spend = Ev<'agent-spend'>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
/** The weeks the weekly chart shows. */
const WEEKS = 8;
/** About this many characters make a token, for tool output. */
const CHARS_PER_TOKEN = 4;

/** The acceptance criteria of a description: its checklist lines, done or not. */
export function criteriaCount(description: string): number {
  return (description.match(/^\s*[-*] \[[ xX]\]/gm) ?? []).length;
}

/** What the productivity section reads of the event log. */
export interface SpendSource {
  between(from: number, to: number): readonly Ev[];
  ticketEvents(id: string): readonly Ev[];
}

interface Range {
  from: number;
  to: number;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const tokensOf = (s: Spend) => s.data.tokens.input + s.data.tokens.output + s.data.tokens.cacheRead + s.data.tokens.cacheCreation;
const round2 = (x: number) => Math.round(x * 100) / 100;
const minutes = (ms: number) => Math.round(ms / MINUTE);
const byValue = (rows: MetricRow[]) => [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

/** The value at a fraction (0.5, 0.9) of sorted numbers. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function number(
  id: string,
  label: string,
  unit: MetricNumber['unit'],
  value: number,
  previous: number,
  rows: MetricRow[],
  lowerIsBetter = false,
): MetricNumber {
  return { id, label, unit, value, previous, rows, ...(lowerIsBetter ? { lowerIsBetter } : {}) };
}

/** The tickets done in a range (merged, or moved to Done), with when. */
function doneIn(events: readonly Ev[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events)
    if (e.ticket && (e.kind === 'merge-landed' || (e.kind === 'ticket-moved' && (e as Ev<'ticket-moved'>).data.to === 'done'))) out.set(e.ticket, e.t);
  return out;
}

/** A done ticket's criteria: those recorded when it was done, else those its description has now. */
function criteriaOf(source: SpendSource, id: string, criteria: ReadonlyMap<string, number>): number {
  const events = source.ticketEvents(id);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'ticket-moved' && (e as Ev<'ticket-moved'>).data.to === 'done' && typeof (e as Ev<'ticket-moved'>).data.criteria === 'number')
      return (e as Ev<'ticket-moved'>).data.criteria!;
  }
  return criteria.get(id) ?? 0;
}

const LANES: ReadonlyArray<[string, string]> = [
  ['todo', 'To Do'],
  ['doing', 'In Progress'],
  ['review', 'In Review'],
];

/** The time a ticket spent in each lane, up to `until`: from its moves. */
export function laneTimes(events: readonly Ev[], until: number): Record<string, number> {
  const out: Record<string, number> = {};
  let lane: string | undefined;
  let since = 0;
  for (const e of events) {
    if (e.t > until) break;
    if (e.kind !== 'ticket-moved') continue;
    if (lane) out[lane] = (out[lane] ?? 0) + e.t - since;
    lane = (e as Ev<'ticket-moved'>).data.to;
    since = e.t;
  }
  if (lane && lane !== 'done') out[lane] = (out[lane] ?? 0) + Math.max(0, until - since);
  return out;
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${Math.round(h / 24)}d`;
}

/** A done ticket: what it cost all told, its criteria, and its turns. */
interface DoneTicket {
  id: string;
  at: number;
  usd: number;
  tokens: number;
  criteria: number;
  turns: number;
  lanes: Record<string, number>;
}

function doneTicket(source: SpendSource, id: string, at: number, criteria: ReadonlyMap<string, number>): DoneTicket {
  const events = source.ticketEvents(id);
  const spend = events.filter((e) => e.kind === 'agent-spend') as Spend[];
  return {
    id,
    at,
    usd: sum(spend.map((s) => s.data.costUsd)),
    tokens: sum(spend.map(tokensOf)),
    criteria: criteriaOf(source, id, criteria),
    turns: sum(spend.map((s) => s.data.contextK.length)),
    lanes: laneTimes(events, at),
  };
}

/** A range's numbers, counted the same way for it and for the one before. */
interface Counted {
  spend: Spend[];
  usd: number;
  tokens: number;
  done: DoneTicket[];
  criteria: number;
  contexts: number[];
}

function count(source: SpendSource, r: Range, criteria: ReadonlyMap<string, number>): Counted {
  const events = source.between(r.from, r.to);
  const spend = events.filter((e) => e.kind === 'agent-spend') as Spend[];
  const done = [...doneIn(events)].map(([id, at]) => doneTicket(source, id, at, criteria));
  return {
    spend,
    usd: sum(spend.map((s) => s.data.costUsd)),
    tokens: sum(spend.map(tokensOf)),
    done,
    criteria: sum(done.map((d) => d.criteria)),
    contexts: spend.flatMap((s) => s.data.contextK.map((k) => k * 1000)).sort((a, b) => a - b),
  };
}

const perUsd = (c: Counted) => (c.usd ? round2(c.criteria / c.usd) : 0);
const perMTok = (c: Counted) => (c.tokens ? round2(c.criteria / (c.tokens / 1e6)) : 0);
const ticketCost = (c: Counted) => (c.done.length ? sum(c.done.map((d) => d.usd)) / c.done.length : 0);
const outside = (c: Counted) =>
  c.usd ? Math.round((sum(c.spend.filter((s) => s.data.purpose === 'orchestration').map((s) => s.data.costUsd)) / c.usd) * 100) : 0;
const turns = (c: Counted) => (c.done.length ? Math.round(sum(c.done.map((d) => d.turns)) / c.done.length) : 0);

function ticketRow(d: DoneTicket): MetricRow {
  const lanes = LANES.filter(([k]) => d.lanes[k] >= MINUTE).map(([k, label]) => `${label} ${formatMinutes(minutes(d.lanes[k]))}`);
  const per = d.criteria ? `$${(d.usd / d.criteria).toFixed(2)} per criterion` : 'no criteria';
  return { label: d.id, ticket: d.id, detail: [`${d.criteria} criteria`, per, `${d.turns} turns`, ...lanes].join(' · '), value: d.usd, unit: 'usd' };
}

/** The bars of a ratio over buckets: criteria done in each per $ spent in it, with its tickets. */
function ratioBars(source: SpendSource, cols: ReadonlyArray<{ from: number; to: number; label: string }>, criteria: ReadonlyMap<string, number>): MetricBar[] {
  return cols.map((k) => {
    const c = count(source, k, criteria);
    return {
      label: k.label,
      values: [perUsd(c)],
      rows: [{ label: `${c.criteria} criteria for $${c.usd.toFixed(2)}`, value: c.usd, unit: 'usd' as const }, ...byValue(c.done.map(ticketRow))],
    };
  });
}

/** The productivity section of the period [cur.from, cur.to), compared with prev; cols: its buckets. */
export function productivitySection(
  source: SpendSource,
  o: {
    period: MetricsPeriod;
    cur: Range;
    prev: Range;
    cols: ReadonlyArray<{ from: number; to: number; label: string }>;
    when: string;
    criteria?: ReadonlyMap<string, number>;
  },
): MetricSection {
  const criteria = o.criteria ?? new Map<string, number>();
  const a = count(source, o.cur, criteria);
  const b = count(source, o.prev, criteria);
  const doneRows = byValue(a.done.map(ticketRow));
  const purposeRows = (p: SpendPurpose) => {
    const by = new Map<string, MetricRow>();
    for (const s of a.spend.filter((x) => x.data.purpose === p)) {
      const key = s.ticket ?? s.data.session;
      const row = by.get(key) ?? {
        label: s.ticket ?? `chat ${s.data.session.slice(0, 8)}`,
        ...(s.ticket ? { ticket: s.ticket } : {}),
        detail: s.agent ?? 'you',
        value: 0,
        unit: 'usd' as const,
      };
      row.value = (row.value ?? 0) + s.data.costUsd;
      by.set(key, row);
    }
    return byValue([...by.values()]).slice(0, 30);
  };
  const tools = (k: ToolKind) => Math.round(sum(a.spend.map((s) => s.data.tools[k] ?? 0)) / CHARS_PER_TOKEN);
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const to = o.cur.to - (WEEKS - 1 - i) * WEEK;
    const from = to - WEEK;
    const d = new Date(from);
    return { from, to, label: `${d.getMonth() + 1}/${d.getDate()}` };
  });
  const day = o.period === 'day';
  return {
    id: 'productivity',
    title: 'Productivity',
    numbers: [
      number(
        'criteriaPerUsd',
        'Criteria done per $',
        'ratio',
        perUsd(a),
        perUsd(b),
        doneRows.map((r) => ({ ...r })),
      ),
      number('criteriaPerMTok', 'Criteria per million tokens', 'ratio', perMTok(a), perMTok(b), doneRows),
      number('costPerTicket', 'Cost per ticket done', 'usd', ticketCost(a), ticketCost(b), doneRows, true),
      number('outsideTickets', 'Spend outside tickets', 'percent', outside(a), outside(b), purposeRows('orchestration'), true),
      number('contextP50', 'Context per turn (median)', 'tokens', quantile(a.contexts, 0.5), quantile(b.contexts, 0.5), [], true),
      number('contextP90', 'Context per turn (p90)', 'tokens', quantile(a.contexts, 0.9), quantile(b.contexts, 0.9), [], true),
      number(
        'turnsPerTicket',
        'Turns per ticket done',
        'count',
        turns(a),
        turns(b),
        byValue(a.done.map((d) => ({ label: d.id, ticket: d.id, value: d.turns, unit: 'count' as const }))),
        true,
      ),
    ],
    charts: [
      {
        id: 'criteriaPerUsdPerDay',
        label: day ? 'Criteria per $, per hour' : 'Criteria per $, per day',
        kind: 'columns',
        unit: 'ratio',
        series: [''],
        bars: ratioBars(source, o.cols, criteria),
        empty: `No spend recorded ${o.when}`,
      },
      {
        id: 'criteriaPerUsdPerWeek',
        label: 'Criteria per $, per week',
        kind: 'columns',
        unit: 'ratio',
        series: [''],
        bars: ratioBars(source, weeks, criteria),
        empty: 'No spend recorded in the last 8 weeks',
      },
      {
        id: 'spendByPurpose',
        label: 'Where the spend went',
        kind: 'rows',
        unit: 'usd',
        series: [''],
        bars: SPEND_PURPOSES.map((p) => ({
          label: PURPOSE_LABEL[p],
          values: [sum(a.spend.filter((s) => s.data.purpose === p).map((s) => s.data.costUsd))],
          rows: purposeRows(p),
        })),
        empty: `No spend recorded ${o.when}`,
      },
      {
        id: 'ticketsDone',
        label: 'Tickets done, costliest first: cost, criteria, time per lane',
        kind: 'rows',
        unit: 'usd',
        series: [''],
        bars: doneRows.slice(0, 25).map((r) => ({ label: r.label, values: [r.value ?? 0], rows: [r] })),
        empty: `No tickets done ${o.when}`,
      },
      {
        id: 'toolOutput',
        label: 'Tool output read, by kind (tokens)',
        kind: 'rows',
        unit: 'tokens',
        series: [''],
        bars: TOOL_KINDS.map((k) => ({ label: TOOL_LABEL[k], values: [tools(k)], rows: [] })),
        empty: `No tool output recorded ${o.when}`,
      },
    ],
  };
}
