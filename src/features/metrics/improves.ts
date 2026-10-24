import type { FlotillaEvent } from './events';
import { eventsBetween, formatValue, metricDefs, trend } from './summary';

/**
 * A ticket's `Improves:` line (BL-159): the metric its fix should move (a summary metric's id), and the value it aims
 * for. "Improves: conflicts-per-merge from 0.4 to 0.2" names conflicts-per-merge, target 0.2.
 */
export interface Improves {
  metric: string;
  target?: number;
  /** The line as written, after "Improves:". */
  text: string;
}

/** The `Improves:` lines of a ticket's description. */
export function readImproves(description: string): Improves[] {
  const out: Improves[] = [];
  for (const m of description.matchAll(/^\s*(?:[-*]\s+)?(?:\*\*)?Improves(?:\*\*)?:(?:\*\*)?\s*(.+)$/gim)) {
    const text = m[1].trim();
    const metric = /`?([a-z][a-z0-9-]*)`?/.exec(text)?.[1];
    if (!metric) continue;
    const rest = text.slice(text.indexOf(metric) + metric.length);
    // The target: the number after "to" (or →), else the last number written.
    const to = /(?:\bto\b|→|->)\s*[≤≥<>=~]*\s*\$?(-?\d+(?:\.\d+)?)/i.exec(rest)?.[1];
    const last = [...rest.matchAll(/-?\d+(?:\.\d+)?/g)].pop()?.[0];
    const target = to ?? last;
    out.push({ metric, ...(target !== undefined ? { target: Number(target) } : {}), text });
  }
  return out;
}

/** When a ticket's work landed: its last merge, else its last move to Done. */
export function landedAt(events: readonly FlotillaEvent[], ticket: string): Date | undefined {
  let at: string | undefined;
  for (const e of events) {
    if (e.ticket !== ticket) continue;
    if (e.kind === 'merge-landed' || (e.kind === 'ticket-moved' && (e as FlotillaEvent<'ticket-moved'>).data.to === 'done')) if (!at || e.at > at) at = e.at;
  }
  return at ? new Date(at) : undefined;
}

export interface FixCheck {
  ticket: string;
  title: string;
  improves: Improves;
  landed?: string;
  before?: number;
  after?: number;
  unit?: string;
  /** helped / worse / same: after against before; early: landed too lately to tell; unknown: no such metric, or no numbers. */
  verdict: 'helped' | 'worse' | 'same' | 'early' | 'unknown';
  /** Whether after reached the target (when there's one). */
  reached?: boolean;
}

const DAY_MS = 86_400_000;

/**
 * The before and after of a merged fix: its metric over the `days` before it landed, and from then on (at most `days`).
 * Less than `minDays` since it landed is too early to tell.
 */
export function checkFix(
  events: readonly FlotillaEvent[],
  o: { ticket: string; title: string; improves: Improves; now: Date; days?: number; minDays?: number },
): FixCheck {
  const days = o.days ?? 28;
  const base = { ticket: o.ticket, title: o.title, improves: o.improves };
  const def = metricDefs(events).find((d) => d.id === o.improves.metric);
  const landed = landedAt(events, o.ticket);
  if (!def || !landed) return { ...base, ...(landed ? { landed: landed.toISOString() } : {}), verdict: 'unknown' };
  const end = new Date(Math.min(o.now.getTime(), landed.getTime() + days * DAY_MS));
  const before = def.value(eventsBetween(events, new Date(landed.getTime() - days * DAY_MS), landed));
  const after = def.value(eventsBetween(events, landed, end));
  const out = { ...base, landed: landed.toISOString(), before, after, unit: def.unit };
  if (o.now.getTime() - landed.getTime() < (o.minDays ?? 3) * DAY_MS) return { ...out, verdict: 'early' };
  const t = trend({ value: after, previous: before, better: def.better });
  const reached = after === undefined || o.improves.target === undefined ? undefined : def.better === 'lower' ? after <= o.improves.target : after >= o.improves.target;
  return { ...out, verdict: t === 'better' ? 'helped' : (t ?? 'unknown'), ...(reached !== undefined ? { reached } : {}) };
}

/** The checks as a Markdown table, for the review's prompt. */
export function fixesMarkdown(checks: readonly FixCheck[]): string {
  if (!checks.length) return 'No merged ticket has an `Improves:` line yet.';
  const word = { helped: 'helped', worse: 'got worse', same: 'no change', early: 'too early to tell', unknown: 'no numbers' } as const;
  return [
    '| Ticket | Improves | Landed | Before | After | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...checks.map(
      (c) =>
        `| ${c.ticket}: ${c.title.replace(/\|/g, '/')} | ${c.improves.text.replace(/\|/g, '/')} | ${c.landed?.slice(0, 10) ?? '–'} | ${formatValue(c.before, c.unit)} | ${formatValue(c.after, c.unit)} | ${word[c.verdict]}${c.reached === undefined ? '' : c.reached ? ', target reached' : ', target not reached'} |`,
    ),
  ].join('\n');
}
