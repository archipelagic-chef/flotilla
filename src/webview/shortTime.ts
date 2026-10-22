/** A time to say in a line: "20:22" today, "Tue 08:22" on another day (BL-132). */
export function shortTime(at: Date | string, now = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const today = d.toDateString() === now.toDateString();
  return d.toLocaleString(undefined, { ...(today ? {} : { weekday: 'short' }), hour: '2-digit', minute: '2-digit' });
}

/** What a chat that went quiet says (BL-131): "Stopped: no activity since Oct 18, 21:46" (just the time today). */
export function stoppedLabel(at: Date | string, now = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = d.toDateString() === now.toDateString();
  return `Stopped: no activity since ${today ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`}`;
}
