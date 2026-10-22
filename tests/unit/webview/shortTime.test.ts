import { describe, expect, it } from 'vitest';
import { shortTime, stoppedLabel } from '../../../src/webview/shortTime';

describe('shortTime (BL-132)', () => {
  const now = new Date(2026, 9, 20, 16, 40);
  it('says only the time today', () => {
    const later = new Date(2026, 9, 20, 20, 22);
    expect(shortTime(later, now)).toBe(later.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  });
  it('says the day too on another day', () => {
    const tomorrow = new Date(2026, 9, 21, 8, 22);
    expect(shortTime(tomorrow.toISOString(), now)).toContain(tomorrow.toLocaleString(undefined, { weekday: 'short' }));
  });
});

describe('stoppedLabel (BL-131)', () => {
  const now = new Date(2026, 9, 20, 16, 40);
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  it('says the date and time of a chat that went quiet on another day', () => {
    const then = new Date(2026, 9, 18, 21, 46);
    expect(stoppedLabel(then.toISOString(), now)).toBe(`Stopped: no activity since ${then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(then)}`);
  });
  it('says only the time today', () => {
    const then = new Date(2026, 9, 20, 16, 10);
    expect(stoppedLabel(then, now)).toBe(`Stopped: no activity since ${time(then)}`);
  });
});
