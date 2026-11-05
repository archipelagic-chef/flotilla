import type { Chat } from './chats';

/** When each chat was last opened in this window (ms), and since when that's been kept: chats older than that count as seen. */
export interface SeenRecord {
  since: number;
  at: Record<string, number>;
}

/** How many chats' seen times are kept: the oldest go first. */
export const SEEN_LIMIT = 500;

/**
 * Whether a chat has a reply you haven't seen (BL-286): its last turn ended (it finished, or waits for you) after you
 * last opened it here. A chat never opened counts from when the record started, so old chats don't all light up.
 */
export function isUnseen(chat: Pick<Chat, 'id' | 'state' | 'open' | 'updatedAt'>, seen: SeenRecord): boolean {
  if (!chat.open || (chat.state !== 'done' && chat.state !== 'waiting-for-input')) return false;
  return chat.updatedAt.getTime() > (seen.at[chat.id] ?? seen.since);
}

/** The record with `id` seen at `now`, keeping the SEEN_LIMIT most recent. */
export function markSeen(seen: SeenRecord, id: string, now: number): SeenRecord {
  const entries = Object.entries({ ...seen.at, [id]: now })
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEN_LIMIT);
  return { since: seen.since, at: Object.fromEntries(entries) };
}
