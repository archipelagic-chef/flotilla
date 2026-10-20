/** "3 min ago", "2 days ago", like VS Code's timeline. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  const steps: [number, string][] = [
    [60, 'sec'],
    [60, 'min'],
    [24, 'hr'],
    [7, 'day'],
    [4.35, 'wk'],
    [12, 'mo'],
    [Infinity, 'yr'],
  ];
  let v = s;
  for (const [size, unit] of steps) {
    if (v < size) {
      const n = Math.floor(v);
      return unit === 'sec' ? 'now' : `${n} ${unit}${n === 1 || unit === 'min' || unit === 'sec' ? '' : 's'} ago`;
    }
    v /= size;
  }
  return '';
}
