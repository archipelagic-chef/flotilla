import type { SpendCell, SpendTimeline } from '../metricsProtocol';

/** The Spend over time chart's columns (BL-202): a window's hours or days, and the chats stacked by name. */

export type Window = '6h' | '24h' | '7d';
export const WINDOWS: Array<{ id: Window; label: string; buckets: number; day?: true }> = [
  { id: '6h', label: '6 hours', buckets: 6 },
  { id: '24h', label: '24 hours', buckets: 24 },
  { id: '7d', label: '7 days', buckets: 7, day: true },
];
/** The most chats stacked by name: the others are one, "Others". */
export const MOST_CHATS = 8;
export interface Bucket {
  from: number;
  label: string;
  /** The cells in it, by chat, summed. */
  cells: Map<number, SpendCell>;
}

export const tokensOf = (c: SpendCell) => c.input + c.output + c.cacheRead + c.cacheWrite;

/** The window's columns, in local time, ending with the one now is in: hours, or days for 7 days. */
export function buckets(timeline: SpendTimeline, window: Window, now: number): Bucket[] {
  const w = WINDOWS.find((x) => x.id === window)!;
  const end = new Date(now);
  if (w.day) end.setHours(0, 0, 0, 0);
  else end.setMinutes(0, 0, 0);
  const starts: number[] = [];
  for (let i = w.buckets - 1; i >= 0; i--) {
    const d = new Date(end);
    if (w.day) d.setDate(d.getDate() - i);
    else d.setHours(d.getHours() - i);
    starts.push(d.getTime());
  }
  const out: Bucket[] = starts.map((from) => {
    const d = new Date(from);
    const label = w.day ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : `${String(d.getHours()).padStart(2, '0')}:00`;
    return { from, label, cells: new Map() };
  });
  for (const hour of timeline.hours) {
    const t = Date.parse(hour.at);
    if (t < starts[0]) continue;
    let i = starts.length - 1;
    while (i > 0 && starts[i] > t) i--;
    for (const c of hour.cells) {
      const was = out[i].cells.get(c.chat);
      if (!was) out[i].cells.set(c.chat, { ...c, purposes: [...c.purposes] });
      else {
        was.input += c.input;
        was.output += c.output;
        was.cacheRead += c.cacheRead;
        was.cacheWrite += c.cacheWrite;
        was.costUsd += c.costUsd;
        was.turns += c.turns;
        for (const p of c.purposes) if (!was.purposes.includes(p)) was.purposes.push(p);
      }
    }
  }
  return out;
}

/** The chats stacked by name, most first: the rest are "Others". */
export function topChats(bs: readonly Bucket[], value: (c: SpendCell) => number): { shown: number[]; others: Set<number> } {
  const totals = new Map<number, number>();
  for (const b of bs) for (const [chat, c] of b.cells) totals.set(chat, (totals.get(chat) ?? 0) + value(c));
  const order = [...totals.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([chat]) => chat);
  // A ninth chat is shown by name rather than as "Others" of one.
  const cut = order.length > MOST_CHATS + 1 ? MOST_CHATS : order.length;
  return { shown: order.slice(0, cut), others: new Set(order.slice(cut)) };
}
