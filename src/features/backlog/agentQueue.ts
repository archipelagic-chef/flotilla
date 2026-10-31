/**
 * The agents Flotilla starts on its own (reviews and revisions, resumes after a usage limit, the autopilot's new
 * tickets) and the user's replies (answers, requested changes) wait in one queue while the agent limit is reached or
 * the machine is short of memory. They start in this order: a paused agent first (it's put back at the head, see
 * `front`), then the user's replies, then reviews and revisions of work already done, then resumes, then new tickets;
 * first come, first served within each. A start the user asks for runs at once, whatever waits; it still counts toward
 * the limit. Prioritize runs a queued start above the limit, up to a ceiling (see prioritizeAction).
 */

/** What a waiting start is for, in the order they start in. */
export const START_KINDS = ['reply', 'review', 'resume', 'new'] as const;
export type StartKind = (typeof START_KINDS)[number];

/** Why a start waits: no free slot, too little memory (flotilla.agents.minFreeMemoryMB), or the account's usage limit (BL-248). */
export type WaitReason = 'slot' | 'memory' | 'limit';

/** "2nd", "11th", "23rd". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th')}`;
}

/** A run that has been going this long is "just started" (see pauseCost). */
export const JUST_STARTED_MS = 5 * 60_000;

export interface WaitingStart<S> {
  id: string;
  kind: StartKind;
  /** The user asked for it: it waits for memory only (when it said no to starting anyway), never for a slot. */
  manual: boolean;
  reason: WaitReason;
  /** The item's state when the start was decided: it must still be that when the start runs. */
  since: string;
  /** When it began to wait (ms since the epoch). */
  at?: number;
  /** Put back at the head of the queue (an agent paused to make room for a prioritized start): before every kind. */
  front?: boolean;
  /** Runs the start, with the item as it is then. */
  start: S;
}

/** The waiting starts, one per item (a new wait for an item replaces its earlier one). */
export class StartQueue<S> {
  private entries: WaitingStart<S>[] = [];

  get size(): number {
    return this.entries.length;
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  get(id: string): WaitingStart<S> | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(entry: WaitingStart<S>): void {
    this.entries = [...this.entries.filter((e) => e.id !== entry.id), entry];
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** The waits, in the order they start in: the paused ones first, then by kind, then first come first served. */
  ordered(): WaitingStart<S>[] {
    return [...this.entries.filter((e) => e.front), ...START_KINDS.flatMap((kind) => this.entries.filter((e) => !e.front && e.kind === kind))];
  }

  /** The one-based place of an item's wait in that order (undefined if it doesn't wait). */
  place(id: string): number | undefined {
    const at = this.ordered().findIndex((e) => e.id === id);
    return at < 0 ? undefined : at + 1;
  }
}

/**
 * Whether a start may run now. A start the user asks for runs (its memory is asked about first, by the caller).
 * Otherwise it needs a free slot, enough memory, and nothing ahead of it in the queue: `ahead` is 0 for the start at
 * the head of the queue (the one starting now).
 */
export function mayStartNow(o: { manual: boolean; running: number; limit: number; ahead: number; memoryShort: boolean }): boolean {
  return o.manual || (!o.memoryShort && o.running < o.limit && o.ahead === 0);
}

/**
 * What Prioritize does for a queued start: `start` (a free slot, or an extra agent above the limit while fewer than
 * `maxExtra` run above it), `pause` (the ceiling is reached: a running agent must make room), or `memory` (too little
 * memory free: nothing starts above the limit, and nothing is paused for it).
 */
export function prioritizeAction(o: { running: number; limit: number; maxExtra: number; memoryShort: boolean }): 'start' | 'pause' | 'memory' {
  if (o.memoryShort) return 'memory';
  if (o.running < o.limit) return 'start';
  return o.running - o.limit < o.maxExtra ? 'start' : 'pause';
}

/**
 * How cheap it is to stop a running agent, for the pick of the one Prioritize pauses (lower first): reviewers are the
 * cheapest, then agents that just started; an agent running a build or tests costs the most to interrupt.
 */
export function pauseCost(o: { reviewer: boolean; ranForMs: number; busy: boolean }): number {
  return (o.busy ? 4 : 0) + (o.reviewer ? 0 : 2) + (o.ranForMs < JUST_STARTED_MS ? 0 : 1);
}

/** The running agents in the order to pause them: cheapest first, then the one that has run the least. */
export function pauseOrder<T extends { reviewer: boolean; ranForMs: number; busy: boolean }>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => pauseCost(a) - pauseCost(b) || a.ranForMs - b.ranForMs);
}
