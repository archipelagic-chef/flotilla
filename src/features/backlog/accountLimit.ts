import type { UsageLimit } from './limits';

/**
 * When the account's usage limit is known to lift (BL-248): the one place that knows, from any agent's hit (a ticket's,
 * a merge's, a note's, or a probe), so nothing starts into it. Until then the agents' starts wait; when it lifts (its
 * reset passes, or a run started after it got through), those waiting on it are told, once.
 */
export class AccountLimit {
  private until: number | undefined;
  /** When the hold was learned: a run started after it that got through shows it lifted (see gotThrough). */
  private learned = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** An agent hit a limit: a usage limit whose reset was said holds the account until then. Others say nothing of it. */
  hit(limit: Pick<UsageLimit, 'until' | 'known' | 'kind'>): void {
    if (limit.known && limit.kind === 'usage') this.holdUntil(limit.until);
  }

  /** The account is limited until then (a hit, or a pause recorded before this window started); a later reset wins. */
  holdUntil(until: Date): void {
    const t = until.getTime();
    if (t <= this.now() || (this.until !== undefined && t <= this.until)) return;
    if (this.until === undefined) this.learned = this.now();
    this.until = t;
    this.arm();
  }

  /** When the limit lifts, while it holds; undefined when no limit is known to hold. */
  heldUntil(): Date | undefined {
    this.check();
    return this.until === undefined ? undefined : new Date(this.until);
  }

  /** Whether the limit holds now. */
  holds(): boolean {
    return this.heldUntil() !== undefined;
  }

  /** A run started at `startedAt` ended without a limit: if it started after the hold was learned, the limit lifted. */
  gotThrough(startedAt: number): void {
    if (this.until !== undefined && startedAt >= this.learned) this.lift();
  }

  /** Claude takes work again (a probe or Try Now got through): the hold is over, early. */
  lift(): void {
    if (this.until === undefined) return;
    this.until = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // One listener's failure doesn't keep the others waiting.
      }
    }
  }

  /** Called each time the limit lifts. */
  onLifted(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private check(): void {
    if (this.until !== undefined && this.until <= this.now()) this.lift();
  }

  /** Lifts it at its reset (or looks again then: a long wait is timed in parts). */
  private arm(): void {
    clearTimeout(this.timer);
    if (this.until === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.check();
        if (this.until !== undefined && !this.timer) this.arm();
      },
      Math.min(Math.max(1000, this.until - this.now()), 2 ** 31 - 1),
    );
    // It doesn't keep the process (or a test run) alive.
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/** The account's limit, for every agent this window starts. */
export const accountLimit = new AccountLimit();
