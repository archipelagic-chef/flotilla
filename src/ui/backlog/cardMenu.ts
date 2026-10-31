import {
  type BacklogItem,
  branchMatches,
} from '../../features/backlog/backlog';

/**
 * The id of the backlog item a card's menu (or a command with a card's context) is about: the id itself, or the
 * `backlogId` of the context object VS Code passes to a context menu command.
 */
export function backlogIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && typeof (arg as { backlogId?: unknown }).backlogId === 'string') {
    return (arg as { backlogId: string }).backlogId;
  }
  return undefined;
}

/** The worktrees working on an item: those, other than the main one, whose branch carries it (an epic has several). */
export function linkedWorktrees<W extends { worktree: { isMain: boolean; path?: string; branch?: string } }>(
  item: Pick<BacklogItem, 'id' | 'branches' | 'branch' | 'links'>,
  workstreams: readonly W[],
): W[] {
  return workstreams.filter((w) => !w.worktree.isMain && w.worktree.path && w.worktree.branch && branchMatches(item, w.worktree.branch));
}
