import {
  type BacklogData,
  type BacklogItem,
  readyToMerge,
} from './backlog';
import { ordinal } from './mergeTrain';
import {
  ago,
  type Claim,
} from './ticketCheck';

/**
 * What a Check finds of the merge queue and train, and of temporary merge worktrees (BL-166): kept apart from
 * ticketCheck, which the ticket's webview imports (mergeTrain runs git).
 */
const short = (sha: string) => sha.slice(0, 7);

/**
 * A ticket's place in the merge queue and train (BL-166): still a ticket to merge, and its train entry built on its
 * branch's tip as it is now (`tipNow`: undefined when the branch is gone). A ticket whose train conflict is being
 * resolved keeps its place (BL-146).
 */
export function checkQueue(item: BacklogItem, data: Pick<BacklogData, 'mergeQueue' | 'mergeTrain'>, tipNow: string | undefined): Claim | undefined {
  const queue = data.mergeQueue ?? [];
  const at = queue.indexOf(item.id);
  const entry = data.mergeTrain?.entries.find((e) => e.id === item.id);
  if (at < 0 && !entry) return undefined;
  const where = at >= 0 ? 'the merge queue' : 'the merge train';
  const glitch = (text: string, why: string): Claim => ({
    key: 'queue',
    ok: false,
    text,
    cleanup: { kind: 'queue-rebuild' },
    fix: 'rebuilds the merge queue and train',
    note: `Check: ${why}; rebuilt the merge queue and train.`,
  });
  const held = !!item.merging?.train;
  if (!held && !readyToMerge(item)) {
    const state = item.status === 'done' ? 'done' : item.merging ? 'being merged' : 'no longer approved to merge';
    return glitch(`${item.id} is in ${where}, but it's ${state}`, `${item.id} was in ${where}, but it was ${state}`);
  }
  if (entry && tipNow !== entry.tip) {
    const moved = tipNow ? `it's at ${short(tipNow)} now` : 'the branch is gone';
    return glitch(
      `Its train entry was built on \`${entry.branch}\` at ${short(entry.tip)}, but ${moved}`,
      `its train entry was built on \`${entry.branch}\` at ${short(entry.tip)}, but ${moved}`,
    );
  }
  if (entry && at < 0 && !held)
    return glitch(`${item.id} is in the merge train, but not in the merge queue`, `${item.id} was in the merge train, but not in the merge queue`);
  const place = at >= 0 ? `${ordinal(at + 1)} of ${queue.length} in the merge queue` : 'in the merge train';
  const train = entry ? `, its train entry built on its tip ${short(entry.tip)}` : held ? ', its train conflict being resolved' : ', not in the train yet';
  return { key: 'queue', ok: true, text: `${item.id} is ${place}${train}` };
}

/** Ids in the merge queue or train with no ticket (BL-166): ✗, Clean Up rebuilds both. */
export function checkQueueIds(data: Pick<BacklogData, 'items' | 'mergeQueue' | 'mergeTrain'>): Claim[] {
  const ids = new Set(data.items.map((i) => i.id));
  const named = [...new Set([...(data.mergeQueue ?? []), ...(data.mergeTrain?.entries.map((e) => e.id) ?? [])])];
  return named
    .filter((id) => !ids.has(id))
    .map((id) => ({
      key: `queue:${id}`,
      ok: false,
      text: `${id} is in the merge queue or train, but there's no such ticket`,
      cleanup: { kind: 'queue-rebuild' } as const,
      fix: 'rebuilds the merge queue and train',
      note: `Check: ${id} was in the merge queue or train, but there was no such ticket; rebuilt them.`,
    }));
}

/** How old a temporary merge worktree no ticket names must be before it's taken for left behind (a merge runs in it unnamed until it stops). */
export const ORPHAN_MS = 60 * 60_000;

/** A temporary merge worktree that no ticket's merge names (BL-166): ✗, Clean Up removes it, asking first if it has uncommitted changes. */
export function checkOrphan(dir: string, f: { dirty: boolean; modified: Date }, now: Date): Claim {
  return {
    key: `orphan:${dir}`,
    ok: false,
    text: `A temporary merge worktree that no ticket's merge names, last changed ${ago(now.getTime() - f.modified.getTime())} ago: ${dir}${f.dirty ? ' (with uncommitted changes)' : ''}`,
    cleanup: { kind: 'orphan-remove', dir },
    fix: 'removes it (git worktree remove)',
    note: `Check: removed the temporary merge worktree ${dir}, which no ticket's merge named.`,
    ...(f.dirty ? { ask: `The temporary merge worktree ${dir} has uncommitted changes, and no ticket's merge names it. Remove it, with them?` } : {}),
  };
}
