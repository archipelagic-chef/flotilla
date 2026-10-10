/** A chat was started for another worktree; the next new session in this window gets linked to it. */
interface Pending {
  targetGitDir: string;
  /** Sessions that already existed when the chat was started. */
  known: ReadonlySet<string>;
  createdAt: number;
}

export interface Match {
  targetGitDir: string;
  sessionId: string;
}

/** Waits this long for the user to send the chat's first message (which is when Claude Code creates the session). */
export const PENDING_LINK_TTL_MS = 60 * 60_000;

/**
 * Matches chats started from Flotilla with the sessions that then appear. Claude Code doesn't return the id of a new
 * chat, so the first session that wasn't known when the chat was started is taken to be it (oldest request first).
 */
export class PendingLinks {
  private pending: Pending[] = [];
  /** Sessions already linked by an earlier match; never matched again. */
  private readonly claimed = new Set<string>();

  get size(): number {
    return this.pending.length;
  }

  add(targetGitDir: string, known: Iterable<string>, now: number): void {
    this.pending.push({ targetGitDir, known: new Set(known), createdAt: now });
  }

  /** Returns the links to make for the sessions seen now, in order, and forgets the matched and expired requests. */
  match(sessions: readonly string[], now: number): Match[] {
    this.pending = this.pending.filter((p) => now - p.createdAt <= PENDING_LINK_TTL_MS);
    const matches: Match[] = [];
    this.pending = this.pending.filter((p) => {
      const fresh = sessions.find((s) => !p.known.has(s) && !this.claimed.has(s));
      if (!fresh) return true;
      this.claimed.add(fresh);
      matches.push({ targetGitDir: p.targetGitDir, sessionId: fresh });
      return false;
    });
    return matches;
  }
}
