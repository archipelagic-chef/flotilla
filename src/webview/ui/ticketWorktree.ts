import type { WorkstreamView } from '../protocol';

/** Where a group's files are read: its worktree, else the main one (a merged ticket's, whose worktree is gone). */
export function worktreeAt(workstreams: WorkstreamView[], dir: string): WorkstreamView | undefined {
  return workstreams.find((w) => w.path === dir) ?? workstreams.find((w) => w.isMain) ?? workstreams[0];
}
