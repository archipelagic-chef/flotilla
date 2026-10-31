import { describe, expect, it } from 'vitest';
import { AccountLimit } from '../../../src/features/backlog/accountLimit';

describe("the account's usage limit (BL-248)", () => {
  const at = (min: number) => new Date(Date.parse('2026-10-28T18:37:00Z') + min * 60_000);

  it('holds from a usage limit whose reset was said, until then, a later reset winning', () => {
    let now = at(0).getTime();
    const limit = new AccountLimit(() => now);
    limit.hit({ until: at(60), known: false, kind: 'usage' });
    limit.hit({ until: at(60), known: true, kind: 'rate' });
    expect(limit.holds()).toBe(false);
    limit.hit({ until: at(240), known: true, kind: 'usage' });
    limit.hit({ until: at(120), known: true, kind: 'usage' });
    expect(limit.heldUntil()).toEqual(at(240));
    let lifted = 0;
    limit.onLifted(() => lifted++);
    now = at(240).getTime();
    expect(limit.holds()).toBe(false);
    expect(lifted).toBe(1);
  });

  it('lifts early when a run started after it got through, not one started before', () => {
    let now = at(0).getTime();
    const limit = new AccountLimit(() => now);
    let lifted = 0;
    limit.onLifted(() => lifted++);
    const before = now - 1000;
    limit.holdUntil(at(240));
    limit.gotThrough(before);
    expect(limit.holds()).toBe(true);
    now = at(10).getTime();
    limit.gotThrough(now);
    expect(limit.holds()).toBe(false);
    limit.lift();
    expect(lifted).toBe(1);
  });
});
