/**
 * A ticket that can't start before a date (BL-261): "Not before: 2026-11-07" (or "Not before: 2026-11-07 14:00") in
 * its description holds it in To Do until then, as an unmet "Depends on:" does until its ticket is merged. The date is
 * local time; without a time it's that day's start.
 */

const LINE = /^[\s>*_-]*not before[*_]*\s*:?[*_]*\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/im;

/** When the description says its work can start, if it does (an impossible date says nothing). */
export function notBefore(description: string): Date | undefined {
  const m = LINE.exec(description);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map((s) => (s === undefined ? 0 : Number(s)));
  const at = new Date(y, mo - 1, d, h, mi);
  return at.getMonth() === mo - 1 && at.getDate() === d && h < 24 && mi < 60 ? at : undefined;
}

/** Until when the ticket is held: its "Not before" date while that's still to come. */
export function heldUntil(description: string, now = Date.now()): Date | undefined {
  const at = notBefore(description);
  return at && at.getTime() > now ? at : undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "From 7 Nov", "From 7 Nov 14:00"; with the year when it isn't this one ("From 7 Jan 2027"). */
export function fromLabel(at: Date, now = Date.now()): string {
  const year = at.getFullYear() === new Date(now).getFullYear() ? '' : ` ${at.getFullYear()}`;
  const time = at.getHours() || at.getMinutes() ? ` ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
  return `From ${at.getDate()} ${MONTHS[at.getMonth()]}${year}${time}`;
}

/** The Flotilla entry on a ticket its agent found too early, moved back to To Do (the move is noted on its own). */
export function heldEntry(at: Date, now = Date.now()): string {
  return `Its work can't start yet ("Not before:" in its description): it waits in To Do, and the autopilot starts it ${fromLabel(at, now).replace(/^From/, 'on')}.`;
}
