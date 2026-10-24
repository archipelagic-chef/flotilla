/**
 * The backlog's actions in progress (BL-117): a button shows it's working from the click until the host says it's done.
 * Pure (no DOM, no vscode): the host echoes a message back when it's done, as a copy, so the key must come out the same.
 */
import type { BacklogItemView, WebviewMessage } from './protocol';

export type BacklogMessage = Extract<WebviewMessage, { type: 'backlog' }>;

/** What tells one action apart from another: its op, the item it's on, and a fix's kind. */
export function backlogActionKey(m: BacklogMessage): string {
  const id = 'id' in m ? m.id : '';
  return m.op === 'fix' ? `fix:${id}:${m.fix}` : `${m.op}:${id}`;
}

/** The actions the host hasn't finished, by key, with the item each is on. */
export class BusyActions {
  private readonly busy = new Map<string, { id: string | undefined; message: BacklogMessage }>();

  /** Marks an action as working; false when it already is (a second click does nothing). */
  start(m: BacklogMessage): boolean {
    const key = backlogActionKey(m);
    if (this.busy.has(key)) return false;
    this.busy.set(key, { id: 'id' in m ? m.id : undefined, message: m });
    return true;
  }

  /** The host is done with it (or it failed). */
  finish(m: BacklogMessage): void {
    this.busy.delete(backlogActionKey(m));
  }

  has(m: BacklogMessage): boolean {
    return this.busy.has(backlogActionKey(m));
  }

  /** Whether any action on this item is working (its hover buttons stay shown). */
  onItem(id: string): boolean {
    return [...this.busy.values()].some((b) => b.id === id);
  }

  /** The cards dropped in a lane that the host hasn't saved yet, in the order they were dropped. */
  moves(): Array<Extract<BacklogMessage, { op: 'move' }>> {
    return [...this.busy.values()].flatMap((b) => (b.message.op === 'move' ? [b.message] : []));
  }

  /** Drops the actions of items no longer in the backlog (dismissed, deleted); true if any went. */
  prune(ids: ReadonlySet<string>): boolean {
    let changed = false;
    for (const [key, { id }] of this.busy) {
      if (id !== undefined && !ids.has(id)) {
        this.busy.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}

/**
 * The items as they'll be once the cards dropped are saved: each in the lane it was dropped in, before the card it was
 * dropped on (else after the lane's last), a proposal accepted. The card moves at once; the host's post confirms it.
 */
export function withMoves<T extends BacklogItemView>(items: T[], moves: ReadonlyArray<Extract<BacklogMessage, { op: 'move' }>>): T[] {
  let out = items;
  for (const m of moves) {
    const item = out.find((i) => i.id === m.id);
    if (!item) continue;
    const moved = { ...item, status: m.status, proposed: undefined };
    const rest = out.filter((i) => i !== item);
    let at = m.before ? rest.findIndex((i) => i.id === m.before) : -1;
    if (at < 0) {
      const last = rest.map((i) => i.status).lastIndexOf(m.status);
      at = last < 0 ? rest.length : last + 1;
    }
    out = [...rest.slice(0, at), moved, ...rest.slice(at)];
  }
  return out;
}
