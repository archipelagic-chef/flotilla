import type { BacklogItem } from './backlog';
import { entryAgent, sameAgent } from './backlog';
import type { TicketEntry } from './ticket';
import { turnOf } from './turn';

/**
 * What waits on the user, for the backlog's "Needs you" list: an agent's question, work ready for the user's review,
 * approved work not merged yet, a stopped review, a start that failed. Shared by the host and the webview (no node
 * or vscode APIs).
 */
export type NeedKind = 'asking' | 'yours' | 'approved' | 'stopped' | 'failed';

export interface Need {
  kind: NeedKind;
  /** When it began waiting, ISO 8601 (unknown for items from before this was recorded). */
  since?: string;
  /** The ask in one line: the question's first line, "Ready for your review", "Stopped: <reason>". */
  line: string;
}

/** The first line of a report with text (headings and quotes marks dropped). */
function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line?.replace(/^[#>*\s]+/, '') ?? '';
}

/**
 * The row an item has in "Needs you", or none: a ticket in review is in it exactly when its turn is the user's (see
 * turnOf), and a start that failed. Done items and proposals don't wait on the user.
 */
export function needOf(item: BacklogItem, activity: TicketEntry[]): Need | undefined {
  if (item.status === 'done' || item.proposed) return undefined;
  const r = item.review;
  const turn = turnOf(item);
  if (turn?.mine) {
    if (r?.state === 'asking') {
      const report = activity.filter((e) => sameAgent(entryAgent(e.author), r.implementer)).at(-1);
      return { kind: 'asking', since: r.since, line: firstLine(report?.body ?? '') || `${r.implementer ?? 'The agent'} has a question` };
    }
    if (r?.state === 'approved') return { kind: 'approved', since: r.since, line: `Approved by ${r.byUser ? 'you' : r.reviewer}. Ready to merge.` };
    if (r?.state === 'stopped')
      return { kind: 'stopped', since: r.since, line: r.stop?.kind === 'user' ? 'You stopped the review' : `Stopped: ${r.reason ?? 'no verdict.'}` };
    return { kind: 'yours', since: r?.since, line: 'Ready for your review' };
  }
  if (item.startFailed && item.status === 'todo') return { kind: 'failed', since: item.startFailed.since, line: `Couldn't start: ${item.startFailed.message}` };
  return undefined;
}

/** Oldest waiting first; those whose start isn't known go last. */
export function oldestFirst<T extends { need?: Need }>(items: readonly T[]): T[] {
  const at = (i: T) => (i.need?.since ? Date.parse(i.need.since) : Number.POSITIVE_INFINITY);
  return items.filter((i) => i.need).sort((a, b) => at(a) - at(b));
}
