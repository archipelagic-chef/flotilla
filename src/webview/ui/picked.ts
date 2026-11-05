import type {
  BacklogItemView,
  BacklogPart,
  Tool,
  WorkstreamView,
} from '../protocol';
import { branchMatches } from '../../features/backlog/backlog';

/**
 * The item selected in the Backlog (BL-290): what Files, Search and Version Control show. A ticket (with the worktree
 * of its picked, when it has two), a worktree of no ticket, or main, the default.
 */
export type Picked = { kind: 'main' } | { kind: 'ticket'; id: string; worktree?: string } | { kind: 'worktree'; key: string };

export const MAIN: Picked = { kind: 'main' };

export interface Shown {
  picked: Picked;
  /** The worktree the sub-views show; none for a ticket with no worktree (or while the backlog loads). */
  ws?: WorkstreamView;
  /** The selected ticket, a local one. */
  ticket?: BacklogItemView;
  /** The ticket's worktrees, to pick between when it has two. */
  worktrees: WorkstreamView[];
}

/** Files, Search and Version Control are the Backlog's sub-views: they're under its icon in the tool strip. */
export const BACKLOG_VIEWS: readonly Tool[] = ['backlog', 'files', 'search', 'vc'];

/** A ticket's worktrees: those whose branch works on it (not main). */
export function worktreesOf(item: BacklogItemView, workstreams: readonly WorkstreamView[]): WorkstreamView[] {
  return workstreams.filter((w) => !w.isMain && branchMatches(item, w.branch));
}

/** What the selection shows; a ticket or worktree no longer there is main again. */
export function shown(picked: Picked | undefined, workstreams: readonly WorkstreamView[], backlog: readonly BacklogItemView[] | undefined): Shown {
  const main = workstreams.find((w) => w.isMain) ?? workstreams[0];
  const atMain: Shown = { picked: MAIN, ws: main, worktrees: [] };
  if (!picked || picked.kind === 'main') return atMain;
  if (picked.kind === 'worktree') {
    const ws = workstreams.find((w) => w.key === picked.key);
    return ws && !ws.isMain ? { picked, ws, worktrees: [] } : atMain;
  }
  // Until the backlog comes, the ticket stays selected, with nothing to show yet.
  if (!backlog) return { picked, worktrees: [] };
  const ticket = backlog.find((i) => i.id === picked.id && !i.source && !i.proposed);
  if (!ticket) return atMain;
  const worktrees = worktreesOf(ticket, workstreams);
  return { picked, ticket, worktrees, ws: worktrees.find((w) => w.key === picked.worktree) ?? worktrees[0] };
}

/** The item a worktree is shown as: main, the ticket it works on (that worktree of it), or a worktree of its own. */
export function pickFor(key: string, workstreams: readonly WorkstreamView[], backlog: readonly BacklogItemView[] | undefined): Picked {
  const ws = workstreams.find((w) => w.key === key);
  if (!ws || ws.isMain) return MAIN;
  const ticket = backlog?.find((i) => !i.source && !i.proposed && branchMatches(i, ws.branch));
  return ticket ? { kind: 'ticket', id: ticket.id, worktree: key } : { kind: 'worktree', key };
}

export function samePick(a: Picked | undefined, b: Picked | undefined): boolean {
  return JSON.stringify(a ?? MAIN) === JSON.stringify(b ?? MAIN);
}

/** The ticket selected, keeping its worktree when it already was. */
export function pickedTicket(prev: Picked | undefined, id: string): Picked {
  return prev?.kind === 'ticket' && prev.id === id ? prev : { kind: 'ticket', id };
}

/** Selects a ticket (a click on its card, or its tab becoming active), its Backlog on the list; as it was if it's selected already. */
export function selectTicket<T extends { picked?: Picked; backlogPart?: BacklogPart }>(p: T, id: string): T {
  return p.picked?.kind === 'ticket' && p.picked.id === id ? p : { ...p, picked: { kind: 'ticket', id }, backlogPart: 'list' };
}

/**
 * What the tool strip shows selected: Files, Search and Version Control (a window saved on one of the old tools too)
 * as sub-views under the Backlog, and a ticket's Changes, Commits or CI under its card as its Version Control.
 */
export function stripFor(tool: Tool, ticketPart: boolean): { top: Tool; sub?: Tool } {
  if (!BACKLOG_VIEWS.includes(tool)) return { top: tool };
  return { top: 'backlog', sub: ticketPart ? 'vc' : tool };
}
