/**
 * The backlog's actions in progress (BL-117): a button shows it's working from the click until the host says it's done.
 * Pure (no DOM, no vscode): the host echoes a message back when it's done, as a copy, so the key must come out the same.
 */
import type { WebviewMessage } from './protocol';

export type BacklogMessage = Extract<WebviewMessage, { type: 'backlog' }>;

/** What tells one action apart from another: its op, the item it's on, and a fix's kind. */
export function backlogActionKey(m: BacklogMessage): string {
  const id = 'id' in m ? m.id : '';
  return m.op === 'fix' ? `fix:${id}:${m.fix}` : `${m.op}:${id}`;
}

/** The actions the host hasn't finished, by key, with the item each is on. */
export class BusyActions {
  private readonly busy = new Map<string, string | undefined>();

  /** Marks an action as working; false when it already is (a second click does nothing). */
  start(m: BacklogMessage): boolean {
    const key = backlogActionKey(m);
    if (this.busy.has(key)) return false;
    this.busy.set(key, 'id' in m ? m.id : undefined);
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
    return [...this.busy.values()].includes(id);
  }

  /** Drops the actions of items no longer in the backlog (dismissed, deleted); true if any went. */
  prune(ids: ReadonlySet<string>): boolean {
    let changed = false;
    for (const [key, id] of this.busy) {
      if (id !== undefined && !ids.has(id)) {
        this.busy.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}
