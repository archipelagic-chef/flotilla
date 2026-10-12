/** About what an agent's Claude Code process takes once it's running (before its builds and tests). */
export const AGENT_MB = 300;

/** How long a start counts against the free memory: the time an agent takes to be running. */
export const START_WINDOW_MS = 60_000;

/**
 * The agents started but not running yet. Their memory isn't in the free memory yet, so each counts at AGENT_MB until
 * its process has exited or its minute has passed; two starts in quick succession can't both see the same free memory.
 */
export class StartingAgents {
  private readonly starts = new Map<number, number>();
  private next = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a start; the token ends it (when its process exits). */
  begin(): number {
    this.next += 1;
    this.starts.set(this.next, this.now());
    return this.next;
  }

  /** Ends a start: its process has exited, or it never ran. */
  end(token: number): void {
    this.starts.delete(token);
  }

  /**
   * The memory the starts in their minute take, in MB. Also drops the starts that have passed their minute (so it
   * changes the ledger, not just reads it).
   */
  memoryMB(): number {
    const cutoff = this.now() - START_WINDOW_MS;
    for (const [token, at] of this.starts) if (at <= cutoff) this.starts.delete(token);
    return this.starts.size * AGENT_MB;
  }
}
