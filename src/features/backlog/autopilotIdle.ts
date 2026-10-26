import type { BacklogData, BacklogItem } from './backlog';

/**
 * Why the autopilot is idle, and what it did while the user was away (BL-142): the lines its bar shows when it has
 * nothing to start.
 */

/** Where a ticket stands, in a few words: "in review", "merge failed"… */
export function standing(item: BacklogItem): string {
  if (item.merging?.state === 'failed') return 'merge failed';
  if (item.status === 'done') return 'merged';
  if (item.status === 'doing') return 'in progress';
  if (item.status === 'todo') return 'to do';
  return item.review?.state === 'approved' ? 'approved' : 'in review';
}

/** What a ticket waits for the user to do, if it does: a failed merge or start, a question, a review. */
export function needsYou(item: BacklogItem): string | undefined {
  if (item.status === 'done') return undefined;
  if (item.merging?.state === 'failed') return 'merge failed';
  if (item.merging?.state === 'resolved') return 'merge to approve';
  if (item.startFailed) return "couldn't start";
  switch (item.review?.state) {
    case 'asking':
      return 'asks you';
    case 'yours':
      return 'review';
    case 'approved':
      return 'approved, to merge';
    case 'stopped':
      return 'review stopped';
  }
  return undefined;
}

function listed(ids: string[]): string {
  return ids.length > 2 ? `${ids.slice(0, 2).join(', ')}, …` : ids.join(', ');
}

/**
 * Why nothing starts: the To Do tickets that wait for others (`waits`: each one's unmerged dependencies, BL-55), the
 * merges that failed, the starts that failed, or nothing left. Undefined when a ticket could start.
 */
export function idleReason(data: BacklogData, waits: ReadonlyMap<string, readonly string[]>, failedStarts: ReadonlySet<string>): string | undefined {
  const todo = data.items.filter((i) => i.status === 'todo' && !i.proposed && !i.discarded && !i.shaping && !data.items.some((c) => c.parent === i.id));
  const failedMerges = data.items.filter((i) => i.status !== 'done' && i.merging?.state === 'failed').map((i) => i.id);
  const merges = failedMerges.length
    ? `${failedMerges.length} merge${failedMerges.length === 1 ? '' : 's'} failed (${listed(failedMerges)}): ${failedMerges.length === 1 ? 'it needs' : 'they need'} you`
    : undefined;
  const waiting = todo.filter((i) => waits.get(i.id)?.length);
  const cantStart = todo.filter((i) => failedStarts.has(i.id) || i.startFailed);
  if (todo.some((i) => !waits.get(i.id)?.length && !failedStarts.has(i.id) && !i.startFailed)) return undefined;
  const parts: string[] = [];
  if (waiting.length) {
    const first = waiting[0];
    const deps = (waits.get(first.id) ?? []).map((id) => {
      const dep = data.items.find((i) => i.id.toUpperCase() === id.toUpperCase());
      return dep ? `${dep.id} (${standing(dep)})` : id;
    });
    parts.push(`${first.id} waits for ${deps.join(', ')}${waiting.length > 1 ? ` (and ${waiting.length - 1} more wait)` : ''}`);
  }
  if (merges) parts.push(merges);
  if (cantStart.length) parts.push(`${listed(cantStart.map((i) => i.id))} couldn't start: start ${cantStart.length === 1 ? 'it' : 'them'} yourself`);
  return parts.length ? parts.join(' · ') : 'nothing left in To Do';
}

/** The tickets whose agents are through (in review, or merged): what's new among them is the work done meanwhile. */
export function finished(data: BacklogData): Set<string> {
  return new Set(data.items.filter((i) => i.status === 'review' || i.status === 'done').map((i) => i.id));
}

/** The line for the user's return: "Overnight: 6 tickets done, 3 waiting for you" (undefined if nothing happened). */
export function awayLine(before: ReadonlySet<string>, data: BacklogData, overnight: boolean): string | undefined {
  const done = [...finished(data)].filter((id) => !before.has(id)).length;
  const yours = data.items.filter((i) => needsYou(i)).length;
  if (!done && !yours) return undefined;
  const tickets = (n: number) => `${n} ticket${n === 1 ? '' : 's'}`;
  return `${overnight ? 'Overnight' : 'While you were away'}: ${tickets(done)} done, ${yours} waiting for you`;
}

/** Whether an absence spans a night: it took 4 hours or more and went past 3 am. */
export function wasOvernight(from: Date, to: Date): boolean {
  if (to.getTime() - from.getTime() < 4 * 3_600_000) return false;
  const three = new Date(from);
  three.setHours(3, 0, 0, 0);
  if (three.getTime() <= from.getTime()) three.setDate(three.getDate() + 1);
  return three.getTime() <= to.getTime();
}
