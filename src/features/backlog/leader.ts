import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Which window acts on its own for the backlog (the autopilot starting agents, agents going on after a usage limit):
 * one at a time, so two windows never start the same work. The leader writes a heartbeat to leader.json in the
 * backlog's folder; a window takes over when the heartbeat is older than STALE_MS (its window closed).
 */
export const LEADER_FILE = 'leader.json';
const BEAT_MS = 30_000;
const STALE_MS = 90_000;

export class Leader {
  readonly id = crypto.randomUUID();
  private timer: NodeJS.Timeout | undefined;
  private leading = false;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get file(): string {
    return path.join(this.dir, LEADER_FILE);
  }

  private read(): { id?: string; at?: number } | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as { id?: string; at?: number };
    } catch {
      return undefined;
    }
  }

  /** Whether this window leads now: it does, or takes over a lead that went quiet. */
  check(): boolean {
    const current = this.read();
    const free = !current?.id || current.id === this.id || this.now() - (current.at ?? 0) > STALE_MS;
    if (!free) return (this.leading = false);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ id: this.id, at: this.now(), pid: process.pid }));
      fs.renameSync(tmp, this.file);
    } catch {
      return (this.leading = false);
    }
    // Two windows taking over at once: the one whose write stayed leads.
    return (this.leading = this.read()?.id === this.id);
  }

  get isLeader(): boolean {
    return this.leading;
  }

  /** Keeps the heartbeat while this window leads (and checks for a lead to take over). */
  start(onChange?: (leading: boolean) => void): { dispose(): void } {
    const beat = () => {
      const was = this.leading;
      const now = this.check();
      if (now !== was) onChange?.(now);
    };
    beat();
    this.timer = setInterval(beat, BEAT_MS);
    return {
      dispose: () => {
        clearInterval(this.timer);
        // Lets another window lead at once.
        if (this.read()?.id === this.id) fs.rmSync(this.file, { force: true });
      },
    };
  }
}
