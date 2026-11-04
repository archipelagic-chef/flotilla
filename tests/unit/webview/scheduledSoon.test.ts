import {
  describe,
  expect,
  it,
} from 'vitest';
import { soon } from '../../../src/webview/ui/scheduledSoon';

describe("A Scheduled lane row's next run (BL-283)", () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  it('says minutes under an hour, hours under a day, then days', () => {
    expect(soon(at(12), now)).toBe('in 12 min');
    expect(soon(at(3 * 60 + 10), now)).toBe('in 3 h');
    expect(soon(at(4 * 24 * 60), now)).toBe('in 4 d');
  });
  it('never says a time in the past', () => {
    expect(soon(at(-5), now)).toBe('in 0 min');
  });
});
