import { describe, expect, it } from 'vitest';
import { parseUsageLimit, retryDelay } from '../../../src/features/backlog/limits';

// 2026-10-11 14:20 local time.
const now = new Date(2026, 9, 11, 14, 20);
const minutes = (d: Date | undefined) => d && Math.round((d.getTime() - now.getTime()) / 60_000);

describe('usage limits', () => {
  it('reads the reset Claude says', () => {
    const at = Math.floor(new Date(2026, 9, 11, 17, 0).getTime() / 1000);
    expect(parseUsageLimit(`{"is_error":true,"result":"Claude AI usage limit reached|${at}"}`, now)).toMatchObject({ known: true, kind: 'usage' });
    expect(minutes(parseUsageLimit(`Claude AI usage limit reached|${at}`, now)?.until)).toBe(161);
    // A time today, or tomorrow when it has passed.
    expect(minutes(parseUsageLimit('5-hour limit reached ∙ resets 3pm', now)?.until)).toBe(41);
    expect(minutes(parseUsageLimit("You've hit your limit · resets 4:30am", now)?.until)).toBe(14 * 60 + 11);
    // Another zone: UTC 15:00 in a zone with a known offset.
    const utc = parseUsageLimit('5-hour limit reached ∙ resets 3pm (UTC)', now)!;
    expect(utc.known).toBe(true);
    expect(utc.until.getUTCHours()).toBe(15);
    expect(utc.until.getUTCMinutes()).toBe(1);
    const weekly = parseUsageLimit('Weekly limit reached ∙ resets Oct 14, 9am', now)!;
    expect([weekly.until.getMonth(), weekly.until.getDate(), weekly.until.getHours(), weekly.until.getMinutes()]).toEqual([9, 14, 9, 1]);
  });

  it('waits a while when the reset isn\'t said, and knows other errors', () => {
    expect(parseUsageLimit('Usage limit reached. Try again later.', now)).toMatchObject({ known: false, kind: 'usage' });
    expect(minutes(parseUsageLimit('Usage limit reached.', now)?.until)).toBe(30);
    expect(parseUsageLimit('API Error: 529 {"type":"overloaded_error"}', now)).toMatchObject({ kind: 'overloaded' });
    expect(parseUsageLimit('API Error: 429 rate_limit_error', now)).toMatchObject({ kind: 'rate' });
    expect(parseUsageLimit('Error: ENOENT', now)).toBeUndefined();
  });

  it('waits longer each time a retry fails, up to an hour', () => {
    const waits = [0, 1, 2, 3, 4, 5, 50].map((n) => retryDelay('rate', n) / 60_000);
    expect(waits).toEqual([5, 10, 20, 40, 60, 60, 60]);
    expect(retryDelay('overloaded', 1) / 60_000).toBe(10);
    expect([0, 1, 2].map((n) => retryDelay('usage', n) / 60_000)).toEqual([30, 60, 60]);
  });
});
