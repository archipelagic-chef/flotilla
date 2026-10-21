/** A time to say in a line: "20:22" today, "Tue 08:22" on another day (BL-132). */
export function shortTime(at: Date | string, now = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const today = d.toDateString() === now.toDateString();
  return d.toLocaleString(undefined, { ...(today ? {} : { weekday: 'short' }), hour: '2-digit', minute: '2-digit' });
}
