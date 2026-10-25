import { WORKING } from '../../core/diff/refs';
import type { TicketChange } from './ticketChange';

/**
 * Where Open in Version Control on a ticket's Changes leads (BL-173), read from the change the ticket shows (BL-171),
 * so Version Control lands on the same files:
 *
 * - changes: a worktree's Version Control, on the ticket's Changes (the group read from that worktree, dir).
 * - compare: Version Control's compare of two refs (its files, base to head): a branch no worktree has against where it
 *   branched off, or a merge commit against its first parent (a merged ticket whose worktree is gone).
 * - commits: a history, the ticket's commits highlighted (hashes: only those, the ones its Changes are narrowed to,
 *   BL-174): its commits on main, combined, are no one range, nor are commits picked.
 * - none: nothing to show, and why.
 */
export type VcTarget =
  | { kind: 'changes'; dir: string; path?: string }
  | { kind: 'compare'; base: string; head: string; path?: string }
  | { kind: 'commits'; hashes?: string[] }
  | { kind: 'none'; why: string };

/**
 * The target for the section (no at: the first group in a worktree, else the first) or for one of its files (at: its
 * group and path).
 */
export function vcTarget(id: string, change: TicketChange | undefined, at?: { group: number; path: string }): VcTarget {
  if (!change || !change.groups.length) return { kind: 'none', why: `${id} changes no files yet.` };
  const index = at
    ? at.group
    : Math.max(
        0,
        change.groups.findIndex((g) => g.right === WORKING),
      );
  const g = change.groups[index];
  if (!g || (at && !g.files.some((f) => f.path === at.path))) return { kind: 'none', why: `That file is no longer in ${id}'s changes.` };
  const path = at?.path;
  switch (change.stage) {
    case 'work':
      if (g.right === WORKING) return { kind: 'changes', dir: g.dir, ...(path ? { path } : {}) };
      return { kind: 'compare', base: g.left, head: g.branch ?? g.right, ...(path ? { path } : {}) };
    case 'merged':
      return { kind: 'compare', base: g.left, head: g.right, ...(path ? { path } : {}) };
    case 'commits':
      return { kind: 'commits' };
    case 'picked':
      return { kind: 'commits', hashes: change.picked ?? [] };
    default:
      return { kind: 'none', why: `${id} changes no files yet.` };
  }
}
