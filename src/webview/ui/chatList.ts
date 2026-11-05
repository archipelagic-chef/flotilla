import type {
  ChatView,
  WorkstreamView,
} from '../protocol';

/** A chat in the Chats list (BL-286): with the worktree it runs in (or is listed in), and the ticket it belongs to. */
export interface ListedChat {
  chat: ChatView;
  /** Where it's listed: unlink and the context menu act there. */
  ws: WorkstreamView;
  /** The worktree it runs in: its chip. */
  runsIn: WorkstreamView;
  ticket?: string;
}

const TICKET_ID = /^[A-Z][A-Z0-9]*-\d+$/;

/** Whether `a` is the better copy of a chat to show: where it runs, then the newer. */
const better = (a: ChatView, b: ChatView) => Number(a.linkedBy === 'cwd') - Number(b.linkedBy === 'cwd') || a.at - b.at;

/**
 * Every chat of every worktree, once each, newest first. A chat listed in several worktrees (linked by edits or by
 * hand) is shown once, where it runs. Detached ones (Flotilla's agents) are left out when `hideDetached`.
 */
export function chatList(workstreams: readonly WorkstreamView[], o: { hideDetached?: boolean } = {}): ListedChat[] {
  const byKey = new Map(workstreams.map((w) => [w.key, w]));
  const byId = new Map<string, ListedChat>();
  for (const ws of workstreams) {
    for (const chat of ws.chats) {
      if (o.hideDetached && chat.detached) continue;
      const runsIn = (chat.runsIn && byKey.get(chat.runsIn)) || ws;
      const known = byId.get(chat.id);
      // The copy in the worktree it runs in wins over one linked elsewhere; between two of those, the newer.
      if (known && better(known.chat, chat) >= 0) continue;
      const ticket = chat.agent?.item ?? (TICKET_ID.test(runsIn.label) ? runsIn.label : undefined);
      byId.set(chat.id, { chat, ws, runsIn, ...(ticket ? { ticket } : {}) });
    }
  }
  return [...byId.values()].sort((a, b) => b.chat.at - a.chat.at || a.chat.id.localeCompare(b.chat.id));
}

/** What a row says its state is, in a word: a new reply comes before finished, waiting for you before both. */
export type ListState = 'waiting' | 'unseen' | 'working' | 'stopped' | 'done' | 'ended';

export function listState(chat: ChatView): ListState {
  if (!chat.open || chat.state === 'ended') return 'ended';
  if (chat.stalled) return 'stopped';
  if (chat.state === 'waiting-for-input') return 'waiting';
  if (chat.state === 'working') return 'working';
  return chat.unseen ? 'unseen' : 'done';
}
