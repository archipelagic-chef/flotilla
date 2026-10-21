import { describe, expect, it } from 'vitest';
import { shortTime } from '../../../src/webview/shortTime';

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
