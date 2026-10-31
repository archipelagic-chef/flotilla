/**
 * Editing and deleting your own comments (BL-128). An entry keeps its heading (its date and author), so its anchor
 * (BL-126) stays and replies and links still point at it. What happened to it is a Markdown comment at its end, which
 * Markdown readers don't show and agents read as it is:
 *
 *   ### 2026-10-10 14:03 · You
 *   The comment, as it is now.
 *   <!-- edited 2026-10-10 14:30 -->
 *
 *   ### 2026-10-10 14:05 · You
 *   _Comment deleted._
 *   <!-- deleted 2026-10-10 14:31 -->
 *
 * A deleted comment stays like that while it has replies (they show under it), or while a later entry of the same
 * minute and author would otherwise take its anchor; otherwise it goes.
 */
import { entryAgent } from './backlog';
import {
  entryAnchors,
  parseReply,
  type TicketEntry,
} from './ticket';

/** The author whose entries can be edited and deleted here: the user's own comments. */
export const OWN_AUTHOR = 'You';

export const DELETED_TEXT = '_Comment deleted._';

const MARK = /\n?[ \t]*<!--\s*(edited|deleted)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*-->\s*$/;

/** An entry's body split: its reply line (BL-126, if any), its text, and when it was edited or deleted. */
export interface EntryEdit {
  replyLine?: string;
  text: string;
  edited?: string;
  deleted?: string;
}

export function entryEdit(body: string): EntryEdit {
  const m = MARK.exec(body);
  const rest = m ? body.slice(0, m.index).trim() : body.trim();
  const reply = parseReply(rest);
  const replyLine = reply
    ? rest
        .split(/\r?\n/)
        .find((l) => l.trim() !== '')!
        .trim()
    : undefined;
  const text = reply ? reply.text : rest;
  if (!m) return { ...(replyLine ? { replyLine } : {}), text };
  return { ...(replyLine ? { replyLine } : {}), text: m[1] === 'deleted' ? '' : text, [m[1]]: m[2] };
}

/** The body an entry is written with: its reply line, its text, and its mark. */
function entryBody(edit: EntryEdit): string {
  const mark = edit.deleted ? `<!-- deleted ${edit.deleted} -->` : edit.edited ? `<!-- edited ${edit.edited} -->` : '';
  return [edit.replyLine, edit.deleted ? DELETED_TEXT : edit.text.trim(), mark].filter(Boolean).join('\n');
}

/** Whether the user can edit or delete an entry: one of their own comments, not deleted yet. */
export function editable(e: Pick<TicketEntry, 'author' | 'body'>): boolean {
  return e.author === OWN_AUTHOR && !entryEdit(e.body).deleted;
}

/** The activity with the comment at anchor's text changed (marked edited at date); undefined when it can't be. */
export function editEntry(activity: ReadonlyArray<TicketEntry>, anchor: string, text: string, date: string): TicketEntry[] | undefined {
  const i = entryAnchors(activity).indexOf(anchor);
  if (i < 0 || !editable(activity[i]) || !text.trim()) return undefined;
  const before = entryEdit(activity[i].body);
  if (before.text.trim() === text.trim()) return [...activity];
  const body = entryBody({ ...before, text, edited: date });
  return activity.map((e, n) => (n === i ? { ...e, body } : e));
}

/** The entries that reply to the one at anchor. */
export function repliesOf(activity: ReadonlyArray<TicketEntry>, anchor: string): TicketEntry[] {
  return activity.filter((e) => parseReply(e.body)?.to === anchor);
}

/**
 * The activity with the comment at anchor deleted at date: it goes, or it leaves "Comment deleted" when it has
 * replies or its going would change a later entry's anchor. Undefined when it can't be deleted.
 */
export function deleteEntry(activity: ReadonlyArray<TicketEntry>, anchor: string, date: string): TicketEntry[] | undefined {
  const anchors = entryAnchors(activity);
  const i = anchors.indexOf(anchor);
  if (i < 0 || !editable(activity[i])) return undefined;
  const without = activity.filter((_, n) => n !== i);
  const after = entryAnchors(without);
  const shifts = after.some((a, n) => a !== anchors[n < i ? n : n + 1]);
  if (!repliesOf(activity, anchor).length && !shifts) return without;
  const body = entryBody({ ...entryEdit(activity[i].body), deleted: date });
  return activity.map((e, n) => (n === i ? { ...e, body } : e));
}

/** Whether a deleted comment still shows: it has replies (a deleted one with none is only kept for its anchor). */
export function showsDeleted(activity: ReadonlyArray<TicketEntry>, anchor: string): boolean {
  return repliesOf(activity, anchor).some((r) => !entryEdit(r.body).deleted || showsDeleted(activity, entryAnchors(activity)[activity.indexOf(r)]));
}

/**
 * The agents that read a comment as it was before it was edited: those that replied to it, or, without a reply, the
 * agent whose report came next (it went on from it). By their names ("Iris-3"). With before (an edit's date), only
 * the answers written by then.
 */
export function answeredBy(activity: ReadonlyArray<TicketEntry>, anchor: string, before?: string): string[] {
  const i = entryAnchors(activity).indexOf(anchor);
  if (i < 0) return [];
  const read = (e: TicketEntry) => before === undefined || e.date <= before;
  const replied = repliesOf(activity, anchor)
    .filter(read)
    .map((r) => entryAgent(r.author))
    .filter((a): a is string => !!a);
  if (replied.length) return [...new Set(replied)];
  const next = activity.slice(i + 1).find((e) => entryAgent(e.author) && !parseReply(e.body));
  if (next && !read(next)) return [];
  return next ? [entryAgent(next.author)!] : [];
}
