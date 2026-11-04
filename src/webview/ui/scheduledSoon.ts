/** "in 4 d", "in 3 h", "in 12 min": how soon a task runs next, for its row. */
export function soon(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
}
