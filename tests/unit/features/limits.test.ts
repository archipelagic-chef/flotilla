import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseUsageLimit,
  retryDelay,
} from '../../../src/features/backlog/limits';

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

  it("waits a while when the reset isn't said, and knows other errors", () => {
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

  it('stops growing at 15 minutes once the wait has lasted an hour (BL-179)', () => {
    const hour = 60 * 60_000;
    expect([3, 4, 5, 50].map((n) => retryDelay('rate', n, hour) / 60_000)).toEqual([15, 15, 15, 15]);
    expect(retryDelay('rate', 1, hour) / 60_000).toBe(10);
    expect(retryDelay('usage', 2, 4 * hour) / 60_000).toBe(15);
    expect(retryDelay('rate', 3, hour - 1) / 60_000).toBe(40);
  });

  describe("Claude Code's wordings of 2026-10-23 (BL-184)", () => {
    // 2026-10-23 21:00 UTC: before 11:30pm (UTC) that day, after 4am and 4:30am (UTC).
    const at = new Date(Date.UTC(2026, 9, 23, 21, 0));
    const utc = (s: string, when = at) => {
      const l = parseUsageLimit(s, when)!;
      return { known: l.known, kind: l.kind, at: l.until.toISOString() };
    };

    it('reads the session limit and its reset in UTC, today or tomorrow', () => {
      expect(utc("You've hit your session limit · resets 4am (UTC)")).toEqual({ known: true, kind: 'usage', at: '2026-10-24T04:01:00.000Z' });
      expect(utc("You've hit your session limit · resets 11:30pm (UTC)")).toEqual({ known: true, kind: 'usage', at: '2026-10-23T23:31:00.000Z' });
      expect(utc("You've hit your session limit · resets 4:30am (UTC)")).toEqual({ known: true, kind: 'usage', at: '2026-10-24T04:31:00.000Z' });
      // After 11:30pm it's the next day's; at 3am, 4am is the same day's.
      expect(utc("You've hit your session limit · resets 11:30pm (UTC)", new Date(Date.UTC(2026, 9, 23, 23, 45))).at).toBe('2026-10-24T23:31:00.000Z');
      expect(utc("You've hit your session limit · resets 4am (UTC)", new Date(Date.UTC(2026, 9, 24, 3, 0))).at).toBe('2026-10-24T04:01:00.000Z');
      // Read a little late: the reset just past, not tomorrow's.
      expect(utc("You've hit your session limit · resets 4am (UTC)", new Date(Date.UTC(2026, 9, 24, 4, 2))).at).toBe('2026-10-24T04:03:00.000Z');
    });

    it('reads a zone that differs from the local one', () => {
      // 4am in Tokyo (UTC+9) is 19:00 UTC the day before; at 21:00 UTC it has passed, so the next is a day later.
      expect(utc("You've hit your session limit · resets 4am (Asia/Tokyo)").at).toBe('2026-10-24T19:01:00.000Z');
      expect(utc("You've hit your session limit · resets 6am (Asia/Tokyo)").at).toBe('2026-10-23T21:01:00.000Z');
      expect(utc("You've hit your session limit · resets 4am (America/New_York)").at).toBe('2026-10-24T08:01:00.000Z');
    });

    it('knows the other wordings, and a said reset wins over a 429', () => {
      for (const s of ["You've hit your weekly limit · resets Oct 25, 9am (UTC)", 'Weekly limit reached ∙ resets Oct 25, 9am (UTC)']) {
        expect(utc(s)).toEqual({ known: true, kind: 'usage', at: '2026-10-25T09:01:00.000Z' });
      }
      expect(utc('5-hour limit reached ∙ resets 11:30pm (UTC)').at).toBe('2026-10-23T23:31:00.000Z');
      const json = JSON.stringify({
        type: 'result',
        is_error: true,
        result: "API Error: 429 rate_limit_error · You've hit your session limit · resets 4am (UTC)",
      });
      expect(utc(json)).toEqual({ known: true, kind: 'usage', at: '2026-10-24T04:01:00.000Z' });
      expect(utc('API Error: 429 · limit · resets 4am (UTC)').kind).toBe('usage');
      expect(parseUsageLimit("You've hit your session limit", at)).toMatchObject({ known: false, kind: 'usage' });
    });

    it("keeps what Claude said when it doesn't understand the reset", () => {
      const json = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 429 rate_limit_error: please slow down' });
      expect(parseUsageLimit(`${json}\n`, at)).toMatchObject({ known: false, kind: 'rate', said: 'API Error: 429 rate_limit_error: please slow down' });
      expect(parseUsageLimit('Your quota is used up. Usage limit reached, back soon', at)?.said).toBe('Your quota is used up. Usage limit reached, back soon');
      expect(parseUsageLimit("You've hit your session limit · resets 4am (UTC)", at)?.said).toBeUndefined();
      expect(parseUsageLimit(`rate limit ${'x'.repeat(500)}`, at)?.said).toHaveLength(200);
    });
  });
});
