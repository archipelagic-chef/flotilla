import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A ticket's worktree being created, as a window records it for every window: `<commonDir>/flotilla/creating/<id>.json`. */
export interface CreatingRecord {
  id: string;
  /** The process (the window's extension host) that creates it. */
  pid: number;
  /** The machine it runs on: another one's processes can't be seen. */
  host: string;
  /** When it started (ms). */
  at: number;
}

/** The folder of the records, in the repository's git common dir. */
export function creatingDir(commonDir: string): string {
  return path.join(commonDir, 'flotilla', 'creating');
}

/** Whether a process runs (false when it's gone; one we may not signal runs). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every record in dir, whether its window still runs or not (records that don't parse are skipped). */
export function readCreatingRecords(dir: string): CreatingRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: CreatingRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<CreatingRecord>;
      if (typeof r.id === 'string' && typeof r.pid === 'number') records.push({ id: r.id, pid: r.pid, host: String(r.host ?? ''), at: Number(r.at ?? 0) });
    } catch {
      // Being written, or not ours.
    }
  }
  return records;
}

/** Removes a ticket's record (Check's Clean Up of one whose creation no longer runs). */
export function clearCreatingRecord(dir: string, id: string): void {
  fs.rmSync(path.join(dir, fileName(id)), { force: true });
}

function fileName(id: string): string {
  return `${id.replace(/[^\w.-]/g, '_')}.json`;
}

const POLL_MS = 500;

/**
 * The tickets whose worktree is being created: one creation per ticket at a time. A worktree being created isn't
 * listed until it's done (git worktree add, the setup files, the linked folders take seconds), so without this a second
 * start of the ticket (a second click, the card and the ticket, the autopilot) made another one.
 *
 * With a folder (`attach`), each creation is also recorded there, so other windows see it and don't start their own.
 * Another window's record counts while its process runs on this machine (or it's on another one); one left by a window
 * that closed mid-creation doesn't, and Check clears it.
 */
export class CreatingWorktrees {
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private dir: string | undefined;
  private others = new Set<string>();
  private watcher: fs.FSWatcher | undefined;

  constructor(
    private readonly self: { pid: number; host: string } = { pid: process.pid, host: os.hostname() },
    private readonly alive: (pid: number) => boolean = pidAlive,
  ) {}

  /** Records creations in dir and sees other windows' there. */
  attach(dir: string): { dispose(): void } {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, () => this.reload());
    } catch {
      // Watchers are unreliable on some mounts: reload() on refreshes still sees the records.
    }
    this.reload();
    return {
      dispose: () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.dir = undefined;
      },
    };
  }

  /** Reads other windows' records again; listeners hear when that changes what's being created. */
  reload(): void {
    if (!this.dir) return;
    const next = new Set(
      readCreatingRecords(this.dir)
        .filter((r) => !(r.host === this.self.host && r.pid === this.self.pid))
        .filter((r) => r.host !== this.self.host || this.alive(r.pid))
        .map((r) => r.id),
    );
    const changed = next.size !== this.others.size || [...next].some((id) => !this.others.has(id));
    this.others = next;
    if (changed) this.fire();
  }

  /** Whether the ticket's worktree is being created now, in this window or another. */
  has(id: string): boolean {
    return this.running.has(id) || this.others.has(id);
  }

  /** The tickets whose worktree is being created. */
  ids(): string[] {
    return [...new Set([...this.running.keys(), ...this.others])];
  }

  /** Waits for the ticket's creation to end, if one runs (whether it worked or not), here or in another window. */
  async settled(id: string): Promise<void> {
    await this.running.get(id)?.catch(() => undefined);
    while (!this.running.has(id) && this.others.has(id)) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      this.reload();
    }
  }

  /**
   * Runs create for the ticket, unless one already runs for it: then it returns `{ busy: true }` and create doesn't run.
   * Listeners hear when it starts and when it ends.
   */
  async run<T>(id: string, create: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
    this.reload();
    if (this.has(id)) return { busy: true };
    const work = create();
    this.running.set(id, work);
    this.write(id);
    this.fire();
    try {
      return { busy: false, value: await work };
    } finally {
      this.running.delete(id);
      if (this.dir) clearCreatingRecord(this.dir, id);
      this.fire();
    }
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private write(id: string): void {
    if (!this.dir) return;
    const record: CreatingRecord = { id, pid: this.self.pid, host: this.self.host, at: Date.now() };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, fileName(id));
      fs.writeFileSync(`${file}.${this.self.pid}.tmp`, JSON.stringify(record));
      fs.renameSync(`${file}.${this.self.pid}.tmp`, file);
    } catch {
      // Not recorded: other windows don't see it, as before.
    }
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }
}

/** This window's (every view and the autopilot share it). */
export const creatingWorktrees = new CreatingWorktrees();
