import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  fromLabel,
  heldEntry,
  heldNote,
  heldUntil,
  notBefore,
} from '../../../src/features/backlog/notBefore';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe('"Not before:" in a description (BL-261)', () => {
  it('reads the date, at the start of that day, local time', () => {
    expect(notBefore('Measure it.\n\nNot before: 2026-11-07\n')).toEqual(local(2026, 11, 7));
    expect(notBefore('- **Not before:** 2026-11-07')).toEqual(local(2026, 11, 7));
    expect(notBefore('not before 2026-11-07')).toEqual(local(2026, 11, 7));
  });

  it('reads a time after the date', () => {
    expect(notBefore('Not before: 2026-11-07 14:30')).toEqual(local(2026, 11, 7, 14, 30));
    expect(notBefore('Not before: 2026-11-07T09:05')).toEqual(local(2026, 11, 7, 9, 5));
  });

  it('reads nothing from prose, other lines or impossible dates', () => {
    expect(notBefore('It must not start before 2026-11-07.')).toBeUndefined();
    expect(notBefore('Depends on: BL-2')).toBeUndefined();
    expect(notBefore('Not before: 2026-02-30')).toBeUndefined();
    expect(notBefore('Not before: 2026-11-07 25:00')).toBeUndefined();
  });

  it('holds the ticket only until then', () => {
    const d = 'Not before: 2026-11-07';
    expect(heldUntil(d, local(2026, 11, 6, 23, 59).getTime())).toEqual(local(2026, 11, 7));
    expect(heldUntil(d, local(2026, 11, 7).getTime())).toBeUndefined();
    expect(heldUntil('No date.', local(2026, 1, 1).getTime())).toBeUndefined();
  });

  it('says "From 7 Nov", with the time when there is one and the year when it is not this one', () => {
    const now = local(2026, 10, 31).getTime();
    expect(fromLabel(local(2026, 11, 7), now)).toBe('From 7 Nov');
    expect(fromLabel(local(2026, 11, 7, 9, 0), now)).toBe('From 7 Nov 09:00');
    expect(fromLabel(local(2027, 1, 7), now)).toBe('From 7 Jan 2027');
    expect(heldEntry(local(2026, 11, 7), now)).toContain('the autopilot starts it on 7 Nov.');
    expect(heldNote(local(2026, 11, 7), now)).toMatch(/^From 7 Nov: its work can't start before then/);
  });
});
