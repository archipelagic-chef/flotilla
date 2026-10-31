import type { BacklogItem } from './backlog/backlog';
import { noteNeed } from './backlog/needs';
import { mergeStage } from './backlog/mergeStage';
import {
  type QueuedStart,
  turnOf,
} from './backlog/turn';
import type { AttentionState } from './workstreams/attention';

/**
 * What needs the user now: the tickets waiting for them (a question, work ready for review, approved, a review that
 * stopped, a proposal to accept), the notes whose agent asks (BL-200) and the worktrees waiting for input or reporting an error. Worked out from the state,
 * so the "Needs you" list and the notifications agree. A window notifies about what is new since its last look.
 */
export type NeedsYouKind = 'error' | 'waiting' | 'asks' | 'merge' | 'stopped' | 'review' | 'resolved' | 'approved' | 'proposed';

export interface NeedsYou {
  /** Identifies the need: a need that isn't in the previous list is news. */
  key: string;
  kind: NeedsYouKind;
  ticket?: { id: string; title: string };
  /** The tickets that wait for this one to be merged (BL-238), directly or through a chain. */
  holdsUp?: string[];
  note?: { id: string; title: string };
  worktree?: { key: string; label: string; current: boolean };
}

export interface NeedsYouWorktree {
  key: string;
  label: string;
  attention: AttentionState;
  /** The window the user is in (its worktree): it doesn't notify about its own. */
  current: boolean;
}

/** A note as the list reads it (a NoteView): asking, unless it's handled with another. */
export type NeedsYouNote = Parameters<typeof noteNeed>[0] & { id: string; title: string };

/** The order of the list, and of the groups in a notification. */
const ORDER: readonly NeedsYouKind[] = ['error', 'waiting', 'asks', 'merge', 'stopped', 'review', 'resolved', 'approved', 'proposed'];

/** How each kind reads after its subject: one, and several. */
const PHRASE: Record<NeedsYouKind, readonly [one: string, many: string]> = {
  error: ['reported an error', 'reported errors'],
  waiting: ['is waiting for input', 'are waiting for input'],
  asks: ['asks a question', 'ask questions'],
  merge: ['has a merge that stopped', 'have merges that stopped'],
  stopped: ['has a review that stopped', 'have reviews that stopped'],
  review: ['is ready for your review', 'are ready for your review'],
  resolved: ['has a merge waiting for your approval', 'have merges waiting for your approval'],
  approved: ['is approved, ready to merge', 'are approved, ready to merge'],
  proposed: ['waits for you to accept it', 'wait for you to accept them'],
};

/** Stops and errors read as warnings; the rest as information. */
export function isWarning(kind: NeedsYouKind): boolean {
  return kind === 'error' || kind === 'stopped' || kind === 'merge';
}

function ticketKind(item: BacklogItem & { queued?: QueuedStart }, holding: boolean): NeedsYouKind | undefined {
  if (item.status === 'done') return undefined;
  if (item.proposed) return 'proposed';
  // A ticket in review needs the user when its turn is theirs (as in the "Needs you" list); what they did themselves
  // (stopped a review, moved an item to review) is no news to tell them, unless it holds other tickets up (BL-238).
  // Its merge (BL-229), even checks you stopped yourself: the merge waits in its worktree until you see to it.
  const merge = mergeStage(item.merging);
  if (merge) return !merge.needsYou ? undefined : merge.stage === 'resolved' ? 'resolved' : 'merge';
  const r = item.review;
  if (!turnOf(item)?.mine || !r || (!holding && (r.stop?.kind === 'user' || r.paused?.byUser))) return undefined;
  switch (r.state) {
    case 'asking':
      return 'asks';
    case 'approved':
      return 'approved';
    case 'stopped':
    case 'paused':
      return 'stopped';
    default:
      return 'review';
  }
}

/**
 * What needs the user, in ORDER, those that hold tickets up first (BL-238), and then by name. Agents at work (started,
 * reviewing, revising) never need them. holdsUp: the tickets each one holds up (see holdsUp in mainDrift.ts).
 */
export function needsYouList(
  items: ReadonlyArray<BacklogItem & { queued?: QueuedStart }>,
  worktrees: readonly NeedsYouWorktree[],
  notes: readonly NeedsYouNote[] = [],
  holdsUp: ReadonlyMap<string, readonly string[]> = new Map(),
): NeedsYou[] {
  const out: NeedsYou[] = [];
  for (const item of items) {
    const held = holdsUp.get(item.id) ?? [];
    const kind = ticketKind(item, held.length > 0);
    if (kind) out.push({ key: `${kind}:${item.id}`, kind, ticket: { id: item.id, title: item.title }, ...(held.length ? { holdsUp: [...held] } : {}) });
  }
  for (const note of notes) if (noteNeed(note)) out.push({ key: `asks:${note.id}`, kind: 'asks', note: { id: note.id, title: note.title } });
  for (const wt of worktrees) {
    const kind: NeedsYouKind | undefined = wt.attention === 'waiting-for-input' ? 'waiting' : wt.attention === 'error' ? 'error' : undefined;
    if (kind) out.push({ key: `${kind}:${wt.key}`, kind, worktree: { key: wt.key, label: wt.label, current: wt.current } });
  }
  const holds = (n: NeedsYou) => (n.holdsUp ? 0 : 1);
  return out.sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || holds(a) - holds(b) || subject(a).localeCompare(subject(b), undefined, { numeric: true }),
  );
}

/** The needs in `next` that `prev` (the previous list, if there was one) didn't have. The first list is only a baseline. */
export function newNeeds(prev: ReadonlySet<string> | undefined, next: readonly NeedsYou[]): NeedsYou[] {
  if (!prev) return [];
  return next.filter((n) => !prev.has(n.key));
}

/** The ticket's or note's id, or the worktree's label: what the need is about. */
export function subject(n: NeedsYou): string {
  return n.ticket?.id ?? n.note?.id ?? n.worktree?.label ?? '';
}

/** What the need is, after its subject ("asks a question"). */
export function phrase(kind: NeedsYouKind, many = false): string {
  return PHRASE[kind][many ? 1 : 0];
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Who waits for a need's ticket (BL-238): "BL-208 waits for it", "BL-211 and BL-213 wait for it". */
export function waitsForIt(ids: readonly string[]): string {
  return `${joinNames(ids)} ${ids.length === 1 ? 'waits' : 'wait'} for it`;
}

/**
 * One line for the needs, grouped by kind: "3 tickets need you: BL-4 asks a question, BL-12 and BL-13 are ready for
 * your review." A single need reads as its own sentence: "BL-4 asks a question." Who waits for a ticket is said with
 * it: "BL-172 is approved, ready to merge: BL-208 waits for it." (BL-238), in a list "BL-172 (holds up BL-208)".
 */
export function needsYouMessage(list: readonly NeedsYou[]): string {
  if (list.length === 1) return `${subject(list[0])} ${phrase(list[0].kind)}${list[0].holdsUp ? `: ${waitsForIt(list[0].holdsUp)}` : ''}.`;
  const groups = new Map<NeedsYouKind, NeedsYou[]>();
  for (const n of list) groups.set(n.kind, [...(groups.get(n.kind) ?? []), n]);
  const named = (n: NeedsYou) => (n.holdsUp ? `${subject(n)} (holds up ${joinNames(n.holdsUp)})` : subject(n));
  const clauses = [...groups].map(([kind, ns]) => `${joinNames(ns.map(named))} ${phrase(kind, ns.length > 1)}`);
  const noun = list.every((n) => n.ticket) ? 'ticket' : list.every((n) => n.note) ? 'note' : list.every((n) => n.worktree) ? 'worktree' : 'item';
  return `${list.length} ${noun}s need you: ${clauses.join(', ')}.`;
}
