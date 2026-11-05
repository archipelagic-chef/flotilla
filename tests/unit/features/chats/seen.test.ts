import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isUnseen,
  markSeen,
  SEEN_LIMIT,
} from '../../../../src/features/chats/seen';

/** BL-286: a chat's reply is new until you open the chat in this window. */
describe('unseen replies', () => {
  const chat = (state: 'done' | 'working' | 'waiting-for-input' | 'ended', at: number, open = true) => ({ id: 'c', state, open, updatedAt: new Date(at) });

  it('counts a turn that ended after the chat was last opened', () => {
    expect(isUnseen(chat('done', 20), { since: 0, at: { c: 10 } })).toBe(true);
    expect(isUnseen(chat('waiting-for-input', 20), { since: 0, at: { c: 10 } })).toBe(true);
    expect(isUnseen(chat('done', 20), { since: 0, at: { c: 30 } })).toBe(false);
  });

  it("doesn't count a chat that's still working, or has ended", () => {
    expect(isUnseen(chat('working', 20), { since: 0, at: {} })).toBe(false);
    expect(isUnseen(chat('done', 20, false), { since: 0, at: {} })).toBe(false);
  });

  it('counts a chat never opened from when the record started, so old chats stay seen', () => {
    expect(isUnseen(chat('done', 20), { since: 50, at: {} })).toBe(false);
    expect(isUnseen(chat('done', 60), { since: 50, at: {} })).toBe(true);
  });

  it('marking keeps the most recent ones', () => {
    let seen = { since: 0, at: {} as Record<string, number> };
    for (let i = 0; i < SEEN_LIMIT + 5; i++) seen = markSeen(seen, `c${i}`, i);
    expect(Object.keys(seen.at)).toHaveLength(SEEN_LIMIT);
    expect(seen.at.c0).toBeUndefined();
    expect(seen.at[`c${SEEN_LIMIT + 4}`]).toBe(SEEN_LIMIT + 4);
  });
});
