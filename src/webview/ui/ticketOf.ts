import type { BacklogItemView, WorkstreamView } from '../protocol';
import { branchMatches } from '../../features/backlog/backlog';

/** Finding the ticket that something in Version Control belongs to: a worktree, a commit, a comparison (BL-171, BL-173). */

const local = (backlog: BacklogItemView[] | undefined) => (backlog ?? []).filter((i) => !i.source && !i.proposed);

/** The ticket a worktree works on: the local item whose branch it's on. */
export function ticketOf(ws: WorkstreamView | undefined, backlog: BacklogItemView[] | undefined): BacklogItemView | undefined {
  if (!ws || ws.isMain || !ws.branch) return undefined;
  return ticketOfBranch(ws.branch, backlog);
}

/** The ticket a branch is for. */
export function ticketOfBranch(branch: string | undefined, backlog: BacklogItemView[] | undefined): BacklogItemView | undefined {
  if (!branch) return undefined;
  return local(backlog).find((i) => branchMatches(i, branch));
}

/**
 * The ticket a commit is part of: one whose message starts with its id ("BL-3: …", as the commit hook asks), or the
 * merge of its branch ("Merge branch 'feature/BL-3-…'").
 */
export function ticketOfCommit(commit: { subject: string }, backlog: BacklogItemView[] | undefined): BacklogItemView | undefined {
  const id = /^([A-Za-z][A-Za-z0-9]*-\d+):/.exec(commit.subject)?.[1];
  if (id) return local(backlog).find((i) => i.id.toLowerCase() === id.toLowerCase());
  const merged = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(commit.subject)?.[1];
  return ticketOfBranch(merged, backlog);
}

/** The ticket a comparison is for: the one it was opened for (Open in Version Control), else its head's branch's. */
export function ticketOfComparison(choice: { ticket?: string; head?: string }, backlog: BacklogItemView[] | undefined): BacklogItemView | undefined {
  if (choice.ticket) return local(backlog).find((i) => i.id === choice.ticket);
  return ticketOfBranch(choice.head, backlog);
}
