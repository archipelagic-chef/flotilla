import type { VcFileDiff } from './protocol';

/**
 * The right-click menu's context of a file row in History, Compare and a ticket's Changes and Commits (section vcFile, BL-244).
 * key: the worktree the file is in, if any; onDisk: it's there to reveal or open (not deleted, and a worktree has it);
 * diff: what clicking the row sends, for Open Changes.
 */
export function vcFileContext(key: string | undefined, change: { path: string; kind: string }, diff: VcFileDiff, flotillaWs?: string): Record<string, unknown> {
  const onDisk = !!key && change.kind !== 'deleted';
  return { ...(key ? { key } : {}), path: change.path, onDisk, diff, ...(flotillaWs ? { flotillaWs } : {}) };
}

/** The diff a vcFile menu's Open Changes passes, if it is one a row's click sends. */
export function vcFileDiffOf(arg: unknown): VcFileDiff | undefined {
  const diff = (arg as { diff?: { type?: unknown } } | undefined)?.diff;
  return diff && (diff.type === 'openCommit' || diff.type === 'openTicketChange' || diff.type === 'openCompare') ? (diff as VcFileDiff) : undefined;
}
