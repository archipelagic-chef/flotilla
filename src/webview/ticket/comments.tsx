import { useEffect, useState } from 'preact/hooks';
import { entryDate } from '../../features/backlog/ticket';
import { act } from './actions';

/** Comments sent and not yet done with: each shows at once as an entry, marked "Sending…". */
type SentComment = { text: string; date: string; at: number };
let sendingComments: SentComment[] = [];
const sendingListeners = new Set<() => void>();
/** How many entries the view shows: a comment sent now is confirmed by an entry after these. */
let shownEntries = 0;

/** Sends a comment (from anywhere in the ticket): it shows at once, marked as sending, until the host is done with it. */
export function sendComment(text: string, replyTo?: string) {
  sendingComments = [...sendingComments, { text, date: entryDate(new Date()), at: shownEntries }];
  sendingListeners.forEach((f) => f());
  act({ type: 'comment', text, ...(replyTo ? { replyTo } : {}) }, 'Sending…');
}

/** The window event a Reply button sends (BL-126): the comment box replies to that entry (its detail). */
export const REPLY_TO = 'flotilla-reply-to';

export function useSending(): SentComment[] {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    sendingListeners.add(listener);
    return () => void sendingListeners.delete(listener);
  }, []);
  return sendingComments;
}

/** The host is done with a comment: it no longer shows as sending. */
export function commentSent(text: string) {
  const i = sendingComments.findIndex((c) => c.text === text);
  if (i >= 0) {
    sendingComments = sendingComments.filter((_, j) => j !== i);
    sendingListeners.forEach((f) => f());
  }
}

/** Notes how many entries the view shows. */
export function showingEntries(count: number) {
  shownEntries = count;
}

/** Focuses the comment box (where answers go), scrolled into view. */
export function focusComment() {
  const box = document.querySelector<HTMLTextAreaElement>('.comment-box textarea');
  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box?.focus();
}
