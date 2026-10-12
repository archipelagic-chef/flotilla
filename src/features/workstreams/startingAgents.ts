/** About what an agent's Claude Code process takes once it's running (before its builds and tests). */
export const AGENT_MB = 300;

/** How long a start counts against the free memory after its agent spawned: the time an agent takes to be running. */
export const START_WINDOW_MS = 60_000;

/**
 * How long a start that never spawned keeps its memory. A start gives its memory back when it's given up, so this only
 * catches a start that was lost (a bug): the memory isn't held for good.
 */
export const PENDING_MAX_MS = 10 * 60_000;

/**
 * The agents started but not running yet. Their memory isn't in the free memory yet, so each counts at AGENT_MB: from
 * the check that reserves it (reserve) until its agent has spawned and its minute has passed (spawned), or until its
 * process has exited or it's given up (end). Two starts can't both see the same free memory.
 */
export class StartingAgents {
  /** Each start: when it was reserved or spawned, and whether its agent has spawned. */
  private readonly starts = new Map<number, { at: number; spawned: boolean }>();
  private next = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Reserves a start's memory (where its check passes); it counts until spawned or ended. */
  reserve(): number {
    this.next += 1;
    this.starts.set(this.next, { at: this.now(), spawned: false });
    return this.next;
  }

  /** The reserved start's agent has spawned: its minute counts from now. */
  spawned(token: number): void {
    const start = this.starts.get(token);
    if (start) Object.assign(start, { at: this.now(), spawned: true });
  }

  /** Records a start that spawns at once; the token ends it (when its process exits). */
  begin(): number {
    const token = this.reserve();
    this.spawned(token);
    return token;
  }

  /** Ends a start: its process has exited, or it was given up before its agent spawned. */
  end(token: number): void {
    this.starts.delete(token);
  }

  /**
   * The memory the starts take, in MB: the reserved ones, and the spawned ones in their minute. Also drops the starts
   * that have run out (so it changes the ledger, not just reads it).
   */
  memoryMB(): number {
    const now = this.now();
    for (const [token, { at, spawned }] of this.starts) {
      if (at <= now - (spawned ? START_WINDOW_MS : PENDING_MAX_MS)) this.starts.delete(token);
    }
    return this.starts.size * AGENT_MB;
  }
}
