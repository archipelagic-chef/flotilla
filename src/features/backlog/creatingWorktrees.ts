/**
 * The tickets whose worktree is being created in this window: one creation per ticket at a time. A worktree being
 * created isn't listed until it's done (git worktree add, the setup files, the linked folders take seconds), so without
 * this a second start of the ticket (a second click, the card and the ticket, the autopilot) made another one.
 */
export class CreatingWorktrees {
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();

  /** Whether the ticket's worktree is being created now. */
  has(id: string): boolean {
    return this.running.has(id);
  }

  /** The tickets whose worktree is being created. */
  ids(): string[] {
    return [...this.running.keys()];
  }

  /** Waits for the ticket's creation to end, if one runs (whether it worked or not). */
  async settled(id: string): Promise<void> {
    await this.running.get(id)?.catch(() => undefined);
  }

  /**
   * Runs create for the ticket, unless one already runs for it: then it returns `{ busy: true }` and create doesn't run.
   * Listeners hear when it starts and when it ends.
   */
  async run<T>(id: string, create: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
    if (this.running.has(id)) return { busy: true };
    const work = create();
    this.running.set(id, work);
    this.fire();
    try {
      return { busy: false, value: await work };
    } finally {
      this.running.delete(id);
      this.fire();
    }
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }
}

/** This window's (every view and the autopilot share it). */
export const creatingWorktrees = new CreatingWorktrees();
