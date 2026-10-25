import type { MetricBar, MetricChart, MetricNumber, MetricRow, MetricSection, MetricsPeriod, MetricsView } from '../../webview/metricsProtocol';
import type { AgentRole, EventKind, FlotillaEvent } from './events';
import { productivitySection } from './productivity';

/**
 * The Metrics view's numbers (BL-158), counted from the event log (BL-157) for a period and the one before. Pure: the
 * host keeps an EventIndex of the log and counts from it, with the per-day totals of past days cached in it.
 */

export const PERIOD_DAYS: Record<MetricsPeriod, number> = { day: 1, week: 7, month: 30 };
const PERIOD_NAME: Record<MetricsPeriod, string> = { day: 'today', week: 'this week', month: 'this month' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** An agent's run that never said it ended (its window closed) counts this long at most. */
const RUN_CAP_MS = 6 * HOUR;

type Ev<K extends EventKind = EventKind> = FlotillaEvent<K> & { t: number };

/** A ticket's time from To Do to merged, in phases. */
export type FlowPhase = 'working' | 'waitReview' | 'review' | 'you' | 'merging';
export const PHASES: readonly FlowPhase[] = ['working', 'waitReview', 'review', 'you', 'merging'];
const PHASE_LABEL: Record<FlowPhase, string> = { working: 'Working', waitReview: 'Waiting for review', review: 'In review', you: 'Waiting for you', merging: 'Merging' };

/** What a ticket waits for you to do. */
export type WaitKind = 'approve' | 'answer' | 'merge' | 'stopped';
const WAIT_LABEL: Record<WaitKind, string> = { approve: 'Approve', answer: 'Answer', merge: 'Merge', stopped: 'A stopped review' };
/** The review states that wait for you, and for what. */
const WAITING: Record<string, WaitKind> = { asking: 'answer', yours: 'approve', approved: 'merge', stopped: 'stopped' };

/** Why the autopilot was idle, from its reason. */
export type IdleKind = 'held' | 'limit' | 'you' | 'nothing' | 'other';
const IDLE_LABEL: Record<IdleKind, string> = { held: 'Held back', limit: 'Usage limit', you: 'Waiting for you', nothing: 'Nothing to do', other: 'Other' };

export function idleKind(reason: string): IdleKind {
  if (/usage limit/i.test(reason)) return 'limit';
  if (/needs? you|yourself/.test(reason)) return 'you';
  if (/waits for/.test(reason)) return 'held';
  if (/nothing left/.test(reason)) return 'nothing';
  return 'other';
}

/** A ticket's history as spans: its phases from To Do to merged, and its waits for you. */
export interface TicketFlow {
  ticket: string;
  start?: number;
  /** When it landed (merged, or moved to Done). */
  end?: number;
  phases: Record<FlowPhase, number>;
  waits: Array<{ kind: WaitKind; from: number; to: number }>;
}

/**
 * Walks a ticket's events (in time order) up to `until`: from its first move out of To Do (or its first agent's start)
 * to its merge, each moment goes to one phase. A merge's agent → merging; a working agent → working; a reviewing agent
 * → in review; a wait for you (a question, a review or a merge to approve) → waiting for you; a merge under way →
 * merging; In Review with nobody on it → waiting for review; the rest (In Progress between runs) → working.
 */
export function ticketFlow(ticket: string, events: readonly Ev[], until: number): TicketFlow {
  const phases: Record<FlowPhase, number> = { working: 0, waitReview: 0, review: 0, you: 0, merging: 0 };
  const waits: TicketFlow['waits'] = [];
  const runs = new Map<string, { role: AgentRole; at: number }>();
  let status = 'todo';
  let you: { kind: WaitKind; from: number } | undefined;
  let merging = false;
  let start: number | undefined;
  let end: number | undefined;
  let last: number | undefined;

  const phase = (): FlowPhase => {
    const roles = new Set([...runs.values()].map((r) => r.role));
    if (roles.has('merge')) return 'merging';
    if (roles.has('work')) return 'working';
    if (roles.has('review')) return 'review';
    if (you) return 'you';
    if (merging) return 'merging';
    return status === 'review' ? 'waitReview' : 'working';
  };
  const advance = (t: number) => {
    if (start !== undefined && end === undefined && last !== undefined && t > last) phases[phase()] += t - last;
    last = t;
    for (const [k, r] of runs) if (t - r.at > RUN_CAP_MS) runs.delete(k);
  };
  const setYou = (kind: WaitKind | undefined, t: number) => {
    if (you && you.kind === kind) return;
    if (you && t > you.from) waits.push({ kind: you.kind, from: you.from, to: t });
    you = kind ? { kind, from: t } : undefined;
  };

  for (const e of events) {
    if (e.t > until) break;
    advance(e.t);
    switch (e.kind) {
      case 'ticket-moved': {
        const d = (e as Ev<'ticket-moved'>).data;
        // A ticket taken up again after it landed starts a new way to merged: the one before doesn't count.
        if (end !== undefined && d.to !== 'done') {
          start = undefined;
          end = undefined;
          for (const p of PHASES) phases[p] = 0;
        }
        if (start === undefined && d.to !== 'todo') start = e.t;
        status = d.to;
        if (d.to === 'done') {
          setYou(undefined, e.t);
          if (end === undefined && start !== undefined) end = e.t;
        }
        break;
      }
      case 'agent-started':
      case 'agent-resumed': {
        const d = (e as Ev<'agent-started'>).data;
        if (start === undefined && d.role === 'work') start = e.t;
        runs.set(d.session || `${e.agent ?? ''}|${d.role}`, { role: d.role, at: e.t });
        if (d.role === 'work' || d.role === 'merge') setYou(undefined, e.t);
        break;
      }
      case 'agent-ended':
      case 'agent-paused': {
        const d = (e as Ev<'agent-ended'>).data;
        runs.delete(d.session || `${e.agent ?? ''}|${d.role}`);
        break;
      }
      case 'review-state': {
        const to = (e as Ev<'review-state'>).data.to;
        setYou(to ? WAITING[to] : undefined, e.t);
        break;
      }
      case 'review-verdict': {
        const d = (e as Ev<'review-verdict'>).data;
        if (d.by === 'You') setYou(undefined, e.t);
        else if (d.verdict === 'approved' && !you) setYou('approve', e.t);
        break;
      }
      case 'merge-started':
        merging = true;
        setYou(undefined, e.t);
        break;
      case 'merge-resolved':
        setYou('merge', e.t);
        break;
      case 'merge-approved':
        setYou(undefined, e.t);
        break;
      case 'merge-cancelled':
        merging = false;
        break;
      case 'merge-landed':
        merging = false;
        setYou(undefined, e.t);
        if (start !== undefined) end = e.t;
        break;
    }
  }
  advance(Math.min(until, end ?? until));
  if (you && until > you.from) waits.push({ kind: you.kind, from: you.from, to: until });
  return { ticket, start, end, phases, waits };
}

/** What a day adds up to, cached for the days that are over. */
interface DayTotals {
  done: Set<string>;
  landed: Ev<'merge-landed'>[];
  /** Per role: cost and tokens of the agents that ended. */
  cost: Record<string, { usd: number; tokens: number }>;
  ended: Ev<'agent-ended'>[];
}

function tokensOf(d: FlotillaEvent<'agent-ended'>['data']): number {
  const t = d.tokens;
  return t ? t.input + t.output + t.cacheRead + t.cacheCreation : 0;
}

function lowerBound(events: readonly Ev[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The local midnight of a time. */
export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The event log, sorted, with each ticket's events and the per-day totals of the days that are over. */
export class EventIndex {
  private all: Ev[] = [];
  private tickets = new Map<string, Ev[]>();
  private days = new Map<number, DayTotals>();

  get size(): number {
    return this.all.length;
  }

  /** Adds events (in any order): the days they fall on are counted again. */
  add(events: readonly FlotillaEvent[]): void {
    if (!events.length) return;
    const added = events.map((e) => ({ ...e, t: Date.parse(e.at) })).filter((e) => Number.isFinite(e.t));
    const sorted = added.every((e, i) => (i ? added[i - 1].t <= e.t : true));
    const inOrder = sorted && (!this.all.length || !added.length || this.all[this.all.length - 1].t <= added[0].t);
    for (const e of added) this.all.push(e);
    if (!inOrder) this.all.sort((a, b) => a.t - b.t);
    const touched = new Set<string>();
    for (const e of added) {
      this.days.delete(dayStart(e.t));
      if (!e.ticket) continue;
      let list = this.tickets.get(e.ticket);
      if (!list) this.tickets.set(e.ticket, (list = []));
      list.push(e);
      touched.add(e.ticket);
    }
    if (!inOrder) for (const id of touched) this.tickets.get(id)!.sort((a, b) => a.t - b.t);
  }

  /** The events in [from, to). */
  between(from: number, to: number): Ev[] {
    return this.all.slice(lowerBound(this.all, from), lowerBound(this.all, to));
  }

  ticketEvents(id: string): readonly Ev[] {
    return this.tickets.get(id) ?? [];
  }

  /** A day's totals (a day that's over is counted once; today's again each time). */
  day(start: number, now: number): DayTotals {
    const cached = this.days.get(start);
    if (cached) return cached;
    const t: DayTotals = { done: new Set(), landed: [], cost: {}, ended: [] };
    for (const e of this.between(start, start + DAY)) {
      if (e.kind === 'ticket-moved' && (e as Ev<'ticket-moved'>).data.to === 'done' && e.ticket) t.done.add(e.ticket);
      if (e.kind === 'merge-landed') {
        t.landed.push(e as Ev<'merge-landed'>);
        if (e.ticket) t.done.add(e.ticket);
      }
      if (e.kind === 'agent-ended') {
        const d = (e as Ev<'agent-ended'>).data;
        const c = (t.cost[d.role] ??= { usd: 0, tokens: 0 });
        c.usd += d.costUsd ?? 0;
        c.tokens += tokensOf(d);
        t.ended.push(e as Ev<'agent-ended'>);
      }
    }
    if (start + DAY <= now) this.days.set(start, t);
    return t;
  }
}

/** The buckets of a period: its hours for a day, its days for a week or a month. */
function buckets(period: MetricsPeriod, from: number, to: number): Array<{ from: number; to: number; label: string }> {
  const out: Array<{ from: number; to: number; label: string }> = [];
  if (period === 'day') {
    for (let t = from; t < to; t += HOUR) out.push({ from: t, to: Math.min(to, t + HOUR), label: `${String(new Date(t).getHours()).padStart(2, '0')}:00` });
    return out;
  }
  for (let t = dayStart(from); t < to; ) {
    const d = new Date(t);
    d.setDate(d.getDate() + 1);
    const next = d.getTime();
    const day = new Date(t);
    out.push({ from: Math.max(t, from), to: Math.min(next, to), label: `${day.getMonth() + 1}/${day.getDate()}` });
    t = next;
  }
  return out;
}

const minutes = (ms: number) => Math.round(ms / MINUTE);
const average = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const ROLE_LABEL: Record<string, string> = { work: 'Work', review: 'Review', merge: 'Merge', discuss: 'Discuss', reply: 'Reply' };
const roleOf = (role: string) => ROLE_LABEL[role] ?? role;
const COST_ROLES = ['work', 'review', 'merge', 'other'];
const costRole = (role: string) => (COST_ROLES.includes(role) ? role : 'other');

interface Range {
  from: number;
  to: number;
}

/** A period's numbers, counted the same way for it and for the one before. */
interface Counted {
  done: MetricRow[];
  flows: TicketFlow[];
  landed: MetricRow[];
  conflicted: MetricRow[];
  additions: MetricRow[];
  approvalToLanded: MetricRow[];
  timeouts: MetricRow[];
  failures: MetricRow[];
  rounds: MetricRow[];
  sentBack: MetricRow[];
  idle: Record<IdleKind, MetricRow[]>;
  costByRole: Record<string, { usd: number; tokens: number; rows: MetricRow[] }>;
  tickets: Map<string, { usd: number; tokens: number }>;
  waits: Record<WaitKind, MetricRow[]>;
  clicks: MetricRow[];
}

function count(index: EventIndex, r: Range, now: number): Counted {
  const events = index.between(r.from, r.to);
  const c: Counted = {
    done: [],
    flows: [],
    landed: [],
    conflicted: [],
    additions: [],
    approvalToLanded: [],
    timeouts: [],
    failures: [],
    rounds: [],
    sentBack: [],
    idle: { held: [], limit: [], you: [], nothing: [], other: [] },
    costByRole: {},
    tickets: new Map(),
    waits: { approve: [], answer: [], merge: [], stopped: [] },
    clicks: [],
  };

  // Done: the tickets that landed (merged, or moved to Done) in the period, with their flow.
  const done = new Set<string>();
  for (let d = dayStart(r.from); d < r.to; ) {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const to = next.getTime();
    // A whole day's are cached; the period's first and last days are partly in it.
    if (d >= r.from && to <= r.to) for (const id of index.day(d, now).done) done.add(id);
    else for (const id of landedIn(index.between(Math.max(d, r.from), Math.min(to, r.to)))) done.add(id);
    d = to;
  }
  for (const id of done) {
    const flow = ticketFlow(id, index.ticketEvents(id), r.to);
    const total = flow.start !== undefined && flow.end !== undefined ? flow.end - flow.start : undefined;
    c.done.push({ label: id, ticket: id, ...(total !== undefined ? { value: minutes(total), unit: 'minutes' as const } : {}) });
    if (total !== undefined && flow.end! >= r.from) c.flows.push(flow);
  }

  // Merges: each that landed, whether it conflicted on the way (since its last start), and how long since it was approved.
  for (const e of events) {
    const id = e.ticket ?? '';
    switch (e.kind) {
      case 'merge-landed': {
        const history = index.ticketEvents(id);
        const i = history.indexOf(e);
        let conflict: Ev<'merge-conflicted'> | undefined;
        let approved: number | undefined;
        for (let j = i - 1; j >= 0; j--) {
          const h = history[j];
          if (h.kind === 'merge-conflicted' && !conflict) conflict = h as Ev<'merge-conflicted'>;
          if (approved === undefined && isApproval(h)) approved = h.t;
          if (h.kind === 'merge-landed') break;
        }
        c.landed.push({ label: id, ticket: id, detail: `into ${(e as Ev<'merge-landed'>).data.into}` });
        if (conflict) {
          const files = conflict.data.files;
          const regions = files.flatMap((f) => f.regions);
          const pure = regions.length > 0 && regions.every((x) => x.additions);
          const row = { label: id, ticket: id, detail: `${files.length} file${files.length === 1 ? '' : 's'}${pure ? ', only additions' : ''}`, value: regions.length, unit: 'count' as const };
          c.conflicted.push(row);
          if (pure) c.additions.push(row);
        }
        if (approved !== undefined) c.approvalToLanded.push({ label: id, ticket: id, value: minutes(e.t - approved), unit: 'minutes' });
        break;
      }
      case 'merge-checks-failed': {
        const d = (e as Ev<'merge-checks-failed'>).data;
        const row = { label: id, ticket: id, detail: d.tests.slice(0, 3).join(', ') || undefined };
        (d.failure === 'timeout' ? c.timeouts : c.failures).push(row);
        break;
      }
      case 'review-verdict': {
        const d = (e as Ev<'review-verdict'>).data;
        if (d.verdict === 'changes') c.sentBack.push({ label: id, ticket: id, detail: `round ${d.round}, by ${d.by}` });
        break;
      }
      case 'agent-ended': {
        const d = (e as Ev<'agent-ended'>).data;
        const role = costRole(d.role);
        const x = (c.costByRole[role] ??= { usd: 0, tokens: 0, rows: [] });
        x.usd += d.costUsd ?? 0;
        x.tokens += tokensOf(d);
        x.rows.push({ label: id || (e.agent ?? 'agent'), ticket: e.ticket, detail: `${e.agent ?? 'agent'} · ${roleOf(d.role)}`, value: d.costUsd ?? 0, unit: 'usd' });
        if (e.ticket) {
          const t = c.tickets.get(e.ticket) ?? { usd: 0, tokens: 0 };
          t.usd += d.costUsd ?? 0;
          t.tokens += tokensOf(d);
          c.tickets.set(e.ticket, t);
        }
        break;
      }
      case 'click-waited': {
        const d = (e as Ev<'click-waited'>).data;
        c.clicks.push({ label: d.button, ticket: e.ticket, detail: e.ticket, value: d.ms, unit: 'ms' });
        break;
      }
    }
  }
  c.clicks.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  // Review rounds: the last round of each ticket reviewed in the period.
  const rounds = new Map<string, number>();
  for (const e of events) if (e.kind === 'review-verdict' && e.ticket) rounds.set(e.ticket, Math.max(rounds.get(e.ticket) ?? 0, (e as Ev<'review-verdict'>).data.round || 1));
  for (const [id, n] of rounds) c.rounds.push({ label: id, ticket: id, value: n, unit: 'count' });

  // Waits for you: each ticket's spans of waiting, the part of them in the period.
  const waited = new Set<string>();
  for (const e of events) if (e.ticket) waited.add(e.ticket);
  for (const id of waited) {
    for (const w of ticketFlow(id, index.ticketEvents(id), Math.min(r.to, now)).waits) {
      const ms = overlap(w.from, w.to, r.from, r.to);
      if (ms >= MINUTE) c.waits[w.kind].push({ label: id, ticket: id, value: minutes(ms), unit: 'minutes' });
    }
  }

  // Idle: no agent running, and the autopilot saying why (a usage limit before any reason).
  idleTime(index, r, now, c.idle);
  return c;
}

function isApproval(e: Ev): boolean {
  if (e.kind === 'merge-approved') return true;
  if (e.kind === 'review-state') return (e as Ev<'review-state'>).data.to === 'approved';
  if (e.kind === 'review-verdict') {
    const d = (e as Ev<'review-verdict'>).data;
    return d.verdict === 'approved' && d.by === 'You';
  }
  return false;
}

/** The agents running over time: each run's span (from its start or resume to its end or pause). */
function runs(index: EventIndex, r: Range, now: number): Array<{ from: number; to: number; agent: string; ticket?: string; role: string }> {
  const open = new Map<string, { from: number; agent: string; ticket?: string; role: string }>();
  const out: Array<{ from: number; to: number; agent: string; ticket?: string; role: string }> = [];
  for (const e of index.between(r.from - RUN_CAP_MS, Math.min(r.to, now))) {
    if (e.kind !== 'agent-started' && e.kind !== 'agent-resumed' && e.kind !== 'agent-ended' && e.kind !== 'agent-paused') continue;
    const d = (e as Ev<'agent-started'>).data;
    const key = d.session || `${e.agent ?? ''}|${e.ticket ?? ''}|${d.role}`;
    const was = open.get(key);
    if (was) {
      out.push({ ...was, to: Math.min(e.t, was.from + RUN_CAP_MS) });
      open.delete(key);
    }
    if (e.kind === 'agent-started' || e.kind === 'agent-resumed') open.set(key, { from: e.t, agent: e.agent ?? 'agent', ticket: e.ticket, role: d.role });
  }
  for (const was of open.values()) out.push({ ...was, to: Math.min(now, r.to, was.from + RUN_CAP_MS) });
  return out.filter((x) => x.to > r.from && x.from < r.to);
}

/** The autopilot's idle time in the period by why: no agent running, with a usage limit on or a reason given. */
function idleTime(index: EventIndex, r: Range, now: number, into: Record<IdleKind, MetricRow[]>): void {
  const end = Math.min(r.to, now);
  if (end <= r.from) return;
  const spans = runs(index, r, now);
  // The points where something changes, and the state after each.
  let reason: string | undefined;
  let limitUntil = 0;
  const from = r.from - DAY;
  const changes = index.between(from, end).filter((e) => ['autopilot-idle', 'limit-hit', 'limit-lifted', 'agent-started', 'agent-resumed'].includes(e.kind));
  const limitEnds = changes.filter((e) => e.kind === 'limit-hit').map((e) => Date.parse((e as Ev<'limit-hit'>).data.until ?? '') || e.t + HOUR);
  const points = [...new Set([r.from, end, ...changes.map((e) => e.t), ...limitEnds, ...spans.flatMap((s) => [s.from, s.to])])].filter((t) => t >= r.from && t <= end).sort((a, b) => a - b);
  let ci = 0;
  const totals = new Map<string, { kind: IdleKind; ms: number }>();
  for (let i = 0; i < points.length - 1; i++) {
    const t = points[i];
    while (ci < changes.length && changes[ci].t <= t) {
      const e = changes[ci++];
      if (e.kind === 'autopilot-idle') reason = (e as Ev<'autopilot-idle'>).data.reason;
      else if (e.kind === 'limit-hit') {
        limitUntil = Date.parse((e as Ev<'limit-hit'>).data.until ?? '') || e.t + HOUR;
      } else if (e.kind === 'limit-lifted') limitUntil = 0;
      else reason = undefined;
    }
    const next = points[i + 1];
    if (spans.some((s) => s.from <= t && s.to > t)) continue;
    const limited = limitUntil > t;
    if (!limited && reason === undefined) continue;
    const kind = limited ? 'limit' : idleKind(reason!);
    const label = limited ? 'A usage limit' : reason!;
    const x = totals.get(label) ?? { kind, ms: 0 };
    x.ms += next - t;
    totals.set(label, x);
  }
  for (const [label, x] of totals) if (x.ms >= MINUTE) into[x.kind].push({ label, value: minutes(x.ms), unit: 'minutes' });
}

function number(id: string, label: string, unit: MetricNumber['unit'], value: number, previous: number, rows: MetricRow[], lowerIsBetter = false): MetricNumber {
  return { id, label, unit, value, previous, rows, ...(lowerIsBetter ? { lowerIsBetter } : {}) };
}

function byValue(rows: MetricRow[]): MetricRow[] {
  return [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** The Metrics view of the period ending at now, each number compared with the period before. */
export function computeMetrics(index: EventIndex, period: MetricsPeriod, now: number, opts: { limit?: number; criteria?: ReadonlyMap<string, number> } = {}): MetricsView {
  const len = PERIOD_DAYS[period] * DAY;
  const cur: Range = { from: now - len, to: now };
  const prev: Range = { from: now - 2 * len, to: now - len };
  const a = count(index, cur, now);
  const b = count(index, prev, now);
  const when = PERIOD_NAME[period];
  const cols = buckets(period, cur.from, cur.to);

  // Productivity (BL-189): first, what was delivered for what was spent.
  const productivity = productivitySection(index, { period, cur, prev, cols, when, ...(opts.criteria ? { criteria: opts.criteria } : {}) });

  // Flow.
  const flowTotal = (c: Counted) => average(c.flows.map((f) => f.end! - f.start!));
  const doneDays: MetricBar[] = cols.map((k) => {
    const ids = landedIn(index.between(k.from, k.to));
    return { label: k.label, values: [ids.size], rows: [...ids].map((id) => ({ label: id, ticket: id })) };
  });
  const phaseBars: MetricBar[] = PHASES.map((p) => ({
    label: PHASE_LABEL[p],
    values: [minutes(average(a.flows.map((f) => f.phases[p])))],
    rows: byValue(a.flows.map((f) => ({ label: f.ticket, ticket: f.ticket, value: minutes(f.phases[p]), unit: 'minutes' as const }))),
  }));
  const wip = wipOver(index, cols);
  const flow: MetricSection = {
    id: 'flow',
    title: 'Flow',
    numbers: [
      number('done', 'Tickets done', 'count', a.done.length, b.done.length, a.done),
      number('toMerged', 'To Do to merged', 'minutes', minutes(flowTotal(a)), minutes(flowTotal(b)), byValue(a.done.filter((r) => r.value !== undefined)), true),
    ],
    charts: [
      { id: 'donePerDay', label: period === 'day' ? 'Tickets done per hour' : 'Tickets done per day', kind: 'columns', unit: 'count', series: [''], bars: doneDays, empty: `No tickets done ${when}` },
      { id: 'phases', label: 'Time from To Do to merged (average)', kind: 'rows', unit: 'minutes', series: [''], bars: phaseBars, empty: `No tickets merged ${when}` },
      { id: 'wip', label: 'Work in progress', kind: 'columns', unit: 'count', series: ['In Progress', 'In Review'], bars: wip, empty: `No work in progress ${when}` },
    ],
  };

  // Merges.
  const fileCounts = new Map<string, MetricRow[]>();
  for (const e of index.between(cur.from, cur.to)) {
    if (e.kind !== 'merge-conflicted') continue;
    for (const f of (e as Ev<'merge-conflicted'>).data.files) {
      const list = fileCounts.get(f.file) ?? [];
      list.push({ label: e.ticket ?? '', ticket: e.ticket, value: f.regions.length, unit: 'count', ...(f.regions.length ? { detail: `${f.regions.length} region${f.regions.length === 1 ? '' : 's'}` } : {}) });
      fileCounts.set(f.file, list);
    }
  }
  const conflicted = new Set(a.conflicted.map((r) => r.ticket));
  const files = [...fileCounts].sort((x, y) => y[1].length - x[1].length).slice(0, 10);
  const merges: MetricSection = {
    id: 'merges',
    title: 'Merges',
    numbers: [
      number('merges', 'Merges', 'count', a.landed.length, b.landed.length, a.landed),
      number('conflicted', 'Conflicted', 'percent', pct(a.conflicted.length, a.landed.length), pct(b.conflicted.length, b.landed.length), a.conflicted, true),
      number('additions', 'Of those, only additions', 'percent', pct(a.additions.length, a.conflicted.length), pct(b.additions.length, b.conflicted.length), a.additions),
      number('approvalToLanded', 'Approval to landed', 'minutes', minutes(average(a.approvalToLanded.map((x) => x.value!)) * MINUTE), minutes(average(b.approvalToLanded.map((x) => x.value!)) * MINUTE), byValue(a.approvalToLanded), true),
      number('checksFailed', 'Checks failed', 'count', a.failures.length, b.failures.length, a.failures, true),
      number('checksTimedOut', 'Checks timed out', 'count', a.timeouts.length, b.timeouts.length, a.timeouts, true),
    ],
    charts: [
      {
        id: 'mergesPerDay',
        label: period === 'day' ? 'Merges per hour' : 'Merges per day',
        kind: 'columns',
        unit: 'count',
        series: ['Clean', 'Conflicted'],
        bars: cols.map((k) => {
          const landed = index.between(k.from, k.to).filter((e) => e.kind === 'merge-landed');
          const n = landed.filter((e) => conflicted.has(e.ticket ?? '')).length;
          return { label: k.label, values: [landed.length - n, n], rows: landed.map((e) => ({ label: e.ticket ?? '', ticket: e.ticket, ...(conflicted.has(e.ticket ?? '') ? { detail: 'conflicted' } : {}) })) };
        }),
        empty: `No merges ${when}`,
      },
      { id: 'files', label: 'Most conflicted files', kind: 'rows', unit: 'count', series: [''], bars: files.map(([file, rows]) => ({ label: file, values: [rows.length], rows })), empty: `No conflicts ${when}` },
    ],
  };

  // Agents.
  const spans = runs(index, cur, now);
  const running: MetricBar[] = cols.map((k) => {
    const inside = spans.filter((s) => s.from < k.to && s.to > k.from);
    // The most at once in the bucket.
    const points = inside.map((s) => Math.max(s.from, k.from));
    const peak = points.reduce((m, t) => Math.max(m, inside.filter((s) => s.from <= t && s.to > t).length), 0);
    return { label: k.label, values: [peak], rows: inside.map((s) => ({ label: s.ticket ?? s.agent, ticket: s.ticket, detail: `${s.agent} · ${roleOf(s.role)}`, value: minutes(overlap(s.from, s.to, k.from, k.to)), unit: 'minutes' as const })) };
  });
  const idleKinds = Object.keys(IDLE_LABEL) as IdleKind[];
  const idleSum = (c: Counted, k?: IdleKind) => sum((k ? [k] : idleKinds.filter((x) => x !== 'nothing')).flatMap((x) => c.idle[x].map((r) => r.value ?? 0)));
  const agents: MetricSection = {
    id: 'agents',
    title: 'Agents',
    numbers: [
      number('idle', 'Idle with work waiting', 'minutes', idleSum(a), idleSum(b), byValue(idleKinds.filter((x) => x !== 'nothing').flatMap((x) => a.idle[x])), true),
      number('rounds', 'Review rounds per ticket', 'count', Math.round(average(a.rounds.map((r) => r.value!)) * 10) / 10, Math.round(average(b.rounds.map((r) => r.value!)) * 10) / 10, byValue(a.rounds), true),
      number('sentBack', 'Tickets sent back', 'count', a.sentBack.length, b.sentBack.length, a.sentBack, true),
    ],
    charts: [
      { id: 'running', label: 'Agents running (most at once)', kind: 'columns', unit: 'count', series: [''], bars: running, empty: `No agents ran ${when}`, ...(opts.limit ? { limit: opts.limit } : {}) },
      { id: 'idleWhy', label: 'Idle time, and why', kind: 'rows', unit: 'minutes', series: [''], bars: idleKinds.map((k) => ({ label: IDLE_LABEL[k], values: [idleSum(a, k)], rows: byValue(a.idle[k]) })), empty: `No idle time ${when}` },
    ],
  };

  // Cost.
  const roleSum = (c: Counted, f: 'usd' | 'tokens') => sum(Object.values(c.costByRole).map((x) => x[f]));
  const costliest = [...a.tickets].sort((x, y) => y[1].usd - x[1].usd || y[1].tokens - x[1].tokens).slice(0, 10);
  const costDays = cols.map((k) => {
    const ended = period === 'day' || k.to - k.from < DAY ? index.between(k.from, k.to).filter((e) => e.kind === 'agent-ended') : index.day(k.from, now).ended;
    return { k, ended: ended as Ev<'agent-ended'>[] };
  });
  const perRole = (ended: Ev<'agent-ended'>[], f: 'usd' | 'tokens') =>
    COST_ROLES.map((role) => sum(ended.filter((e) => costRole(e.data.role) === role).map((e) => (f === 'usd' ? (e.data.costUsd ?? 0) : tokensOf(e.data)))));
  const endedRows = (ended: Ev<'agent-ended'>[], f: 'usd' | 'tokens'): MetricRow[] =>
    byValue(ended.map((e) => ({ label: e.ticket ?? e.agent ?? 'agent', ticket: e.ticket, detail: `${e.agent ?? 'agent'} · ${roleOf(e.data.role)}`, value: f === 'usd' ? (e.data.costUsd ?? 0) : tokensOf(e.data), unit: f })));
  const allRows = (c: Counted) => byValue(Object.values(c.costByRole).flatMap((x) => x.rows));
  const cost: MetricSection = {
    id: 'cost',
    title: 'Cost',
    numbers: [
      number('cost', 'Cost', 'usd', roleSum(a, 'usd'), roleSum(b, 'usd'), allRows(a), true),
      number('tokens', 'Tokens', 'tokens', roleSum(a, 'tokens'), roleSum(b, 'tokens'), byValue(allRows(a).map((r) => ({ ...r, value: undefined }))), true),
    ],
    charts: [
      { id: 'costPerDay', label: period === 'day' ? 'Cost per hour' : 'Cost per day', kind: 'columns', unit: 'usd', series: COST_ROLES.map(roleOf), bars: costDays.map(({ k, ended }) => ({ label: k.label, values: perRole(ended, 'usd'), rows: endedRows(ended, 'usd') })), empty: `No agents' cost recorded ${when}` },
      { id: 'tokensPerDay', label: period === 'day' ? 'Tokens per hour' : 'Tokens per day', kind: 'columns', unit: 'tokens', series: COST_ROLES.map(roleOf), bars: costDays.map(({ k, ended }) => ({ label: k.label, values: perRole(ended, 'tokens'), rows: endedRows(ended, 'tokens') })), empty: `No tokens recorded ${when}` },
      { id: 'costPerRole', label: 'Cost per role', kind: 'rows', unit: 'usd', series: [''], bars: COST_ROLES.map((role) => ({ label: roleOf(role), values: [a.costByRole[role]?.usd ?? 0], rows: byValue(a.costByRole[role]?.rows ?? []) })), empty: `No agents' cost recorded ${when}` },
      { id: 'costliest', label: 'Costliest tickets', kind: 'rows', unit: 'usd', series: [''], bars: costliest.map(([id, x]) => ({ label: id, values: [x.usd], rows: [{ label: id, ticket: id, detail: `${Math.round(x.tokens / 1000)}k tokens`, value: x.usd, unit: 'usd' }] })), empty: `No agents' cost recorded ${when}` },
    ],
  };

  // You.
  const waitKinds = Object.keys(WAIT_LABEL) as WaitKind[];
  const waitSum = (c: Counted) => sum(waitKinds.flatMap((k) => c.waits[k].map((r) => r.value ?? 0)));
  const you: MetricSection = {
    id: 'you',
    title: 'You',
    numbers: [
      number('waitedForYou', 'Tickets waited for you', 'minutes', waitSum(a), waitSum(b), byValue(waitKinds.flatMap((k) => a.waits[k].map((r) => ({ ...r, detail: WAIT_LABEL[k] })))), true),
      number('slowClicks', 'Clicks that waited', 'count', a.clicks.length, b.clicks.length, a.clicks, true),
    ],
    charts: [
      { id: 'waitsByKind', label: 'Time waiting for you, by what for', kind: 'rows', unit: 'minutes', series: [''], bars: waitKinds.map((k) => ({ label: WAIT_LABEL[k], values: [sum(a.waits[k].map((r) => r.value ?? 0))], rows: byValue(a.waits[k]) })), empty: `Nothing waited for you ${when}` },
      { id: 'clicks', label: 'Clicks that waited longest', kind: 'rows', unit: 'ms', series: [''], bars: a.clicks.slice(0, 10).map((r) => ({ label: r.label, values: [r.value ?? 0], rows: [r] })), empty: `No click waited a second or more ${when}` },
    ],
  };

  return { period, from: new Date(cur.from).toISOString(), to: new Date(cur.to).toISOString(), sections: [productivity, flow, merges, agents, cost, you], events: index.size };
}

/** The tickets that landed among events: merged, or moved to Done. */
function landedIn(events: readonly Ev[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) if (e.ticket && (e.kind === 'merge-landed' || (e.kind === 'ticket-moved' && (e as Ev<'ticket-moved'>).data.to === 'done'))) ids.add(e.ticket);
  return ids;
}

/** Work in progress at each bucket's end: the tickets In Progress and In Review then. */
function wipOver(index: EventIndex, cols: ReadonlyArray<{ from: number; to: number; label: string }>): MetricBar[] {
  const status = new Map<string, string>();
  const moves = index.between(0, cols.at(-1)?.to ?? 0).filter((e) => e.kind === 'ticket-moved' && e.ticket);
  let i = 0;
  return cols.map((k) => {
    while (i < moves.length && moves[i].t < k.to) {
      status.set(moves[i].ticket!, (moves[i] as Ev<'ticket-moved'>).data.to);
      i++;
    }
    const doing = [...status].filter(([, s]) => s === 'doing').map(([id]) => id);
    const review = [...status].filter(([, s]) => s === 'review').map(([id]) => id);
    return {
      label: k.label,
      values: [doing.length, review.length],
      rows: [...doing.map((id) => ({ label: id, ticket: id, detail: 'In Progress' })), ...review.map((id) => ({ label: id, ticket: id, detail: 'In Review' }))],
    };
  });
}
