/**
 * What changed between two views of a ticket, and how the webview puts a change back into the view it shows. Pure (no
 * DOM, no vscode): the host sends only the parts that differ, the webview merges them.
 */
import type { TicketHostMessage, TicketPart, TicketPartsMessage, TicketView } from './ticketProtocol';

/** What a view sent before is now: the whole view when there was none, the parts that changed, or nothing. */
export function ticketUpdate(before: TicketView | undefined, after: TicketView): TicketHostMessage | undefined {
  if (!before) return { type: 'ticket', ticket: after };
  const parts: Partial<Record<TicketPart, unknown>> = {};
  const removed: TicketPart[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<TicketPart | 'activity'>) {
    if (key === 'activity') continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (after[key] === undefined) removed.push(key);
    else parts[key] = after[key];
  }
  // Entries are kept in order and never change once written: a new one is appended. Anything else (a posted entry, a
  // chat that changed) sends from its place on.
  let keep = 0;
  while (keep < before.activity.length && keep < after.activity.length && JSON.stringify(before.activity[keep]) === JSON.stringify(after.activity[keep])) keep++;
  const activity = keep === before.activity.length && keep === after.activity.length ? undefined : { keep, entries: after.activity.slice(keep) };
  if (!Object.keys(parts).length && !removed.length && !activity) return undefined;
  return {
    type: 'ticketParts',
    parts: parts as TicketPartsMessage['parts'],
    removed,
    ...(activity ? { activity } : {}),
  };
}

/** The view with a change put in: the parts that differ replace the ones shown, the activity keeps its first entries. */
export function applyTicketParts(view: TicketView, change: TicketPartsMessage): TicketView {
  const next: Partial<TicketView> = { ...view, ...change.parts };
  for (const key of change.removed) delete next[key];
  if (change.activity) next.activity = [...view.activity.slice(0, change.activity.keep), ...change.activity.entries];
  return next as TicketView;
}
