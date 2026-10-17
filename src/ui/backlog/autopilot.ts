import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { childrenOf, setStartFailed, type BacklogData, type BacklogItem } from '../../features/backlog/backlog';
import { entryDate } from '../../features/backlog/ticket';
import type { Leader } from '../../features/backlog/leader';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { dependsOn, waitingFor } from '../../features/backlog/mainDrift';
import type { Workstream } from '../../features/workstreams/workstream';
import type { ReviewLoop } from './reviewLoop';
import { memoryShortage } from './agentRunner';

/** The autopilot's switch, shared by every window (in the backlog's folder). */
export const AUTOPILOT_FILE = 'autopilot.json';

export interface AutopilotDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  reviews: ReviewLoop;
  leader: Leader;
  output: vscode.OutputChannel;
  /**
   * The key that signs the switch (from VS Code's secret storage): agents can write the backlog's folder, but can't
   * turn the autopilot on.
   */
  key(): Promise<string>;
  /** A worktree for an item, ready for an agent (created without asking; undefined if it can't be). */
  prepareWorktree(item: BacklogItem): Promise<Workstream | undefined>;
}

/** What the backlog view shows of the autopilot. */
export interface AutopilotView {
  enabled: boolean;
  /** Agents working now (for any work), and the most at once (flotilla.agents.maxRunning). */
  running: number;
  max: number;
  /** Starts waiting for a free slot (or for memory): they go on when there's room, reviews and resumes first. */
  waiting: number;
  /** Waiting for Claude's usage limit to reset (ISO 8601). */
  waitingUntil?: string;
  /** Waiting for free memory: too little to start an agent (flotilla.agents.minFreeMemoryMB). */
  waitingForMemory?: boolean;
  /** Another window runs it. */
  elsewhere: boolean;
}

/**
 * The next items the autopilot takes: To Do, accepted, in the backlog's order; an epic's parts, not the epic. A ticket
 * with a discussion with an agent (BL-45) waits: its owner accepts it or starts it by hand, which ends the discussion
 * (accepting does; a To Do is started with Start), so only then is it taken.
 */
export function nextForAutopilot(data: BacklogData, skip: ReadonlySet<string>): BacklogItem | undefined {
  return data.items.find((i) => i.status === 'todo' && !i.proposed && !i.shaping && !skip.has(i.id) && childrenOf(data, i.id).length === 0);
}

/**
 * The autopilot: while it's on, agents take the backlog's To Do items in order and work on them without a window, up
 * to the agent limit (flotilla.agents.maxRunning) at once, shared with the reviews: a worktree each, In Progress,
 * reports in the ticket; their "Ready for review." goes on to review. Nothing new starts while work waits in the queue
 * (reviews and resumes go first), on a usage limit until it resets (the paused agents go on then), or while the machine
 * is short of memory (it tries again on the next tick). Only the leading window runs it.
 */
export class Autopilot implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Items it couldn't start (this session): not tried again. */
  private readonly failed = new Set<string>();
  private ticking = false;
  private waitingUntil: Date | undefined;
  private waitingForMemory = false;

  constructor(private readonly deps: AutopilotDeps) {
    const watch = deps.backlog.watch(() => void this.refresh().then(() => this.tick()));
    const timer = setInterval(() => void this.tick(), 30_000);
    this.subscriptions.push({ dispose: () => watch.dispose() }, { dispose: () => clearInterval(timer) }, this.changed);
    void this.refresh().then(() => this.tick());
  }

  /** Whether it's on: the switch says so, signed with this machine's key (cached; read again when files change). */
  private on = false;

  private sign(key: string, enabled: boolean): string {
    return crypto.createHmac('sha256', key).update(`flotilla-autopilot:${this.deps.backlog.dir}:${enabled}`).digest('hex');
  }

  private async refresh(): Promise<void> {
    let on = false;
    try {
      const data = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as { enabled?: unknown; mac?: unknown };
      const mac = typeof data.mac === 'string' ? data.mac : '';
      const expected = this.sign(await this.deps.key(), true);
      on = data.enabled === true && mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
    } catch {
      on = false;
    }
    if (on !== this.on) {
      this.on = on;
      this.changed.fire();
    }
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
  }

  private get file(): string {
    return path.join(this.deps.backlog.dir, AUTOPILOT_FILE);
  }

  get enabled(): boolean {
    return this.on;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.backlog.ensureDir();
    const mac = this.sign(await this.deps.key(), enabled);
    await fs.promises.writeFile(this.file, `${JSON.stringify({ enabled, mac }, null, 1)}\n`);
    await this.refresh();
    this.changed.fire();
    if (enabled) {
      // This window runs it, unless another one leads.
      this.deps.leader.check();
      void this.tick();
    }
  }

  view(): AutopilotView {
    return {
      enabled: this.enabled,
      running: this.deps.reviews.running,
      max: this.deps.reviews.limit,
      waiting: this.deps.reviews.waitingCount,
      ...(this.waitingUntil && this.waitingUntil.getTime() > Date.now() ? { waitingUntil: this.waitingUntil.toISOString() } : {}),
      ...(this.waitingForMemory ? { waitingForMemory: true } : {}),
      elsewhere: !this.deps.leader.isLeader,
    };
  }

  /** The To Do tickets that wait for others to be merged ("Depends on: BL-12" in their description, BL-55). */
  private async waiting(data: BacklogData): Promise<string[]> {
    const todo = data.items.filter((i) => i.status === 'todo' && !i.proposed);
    const waits = await Promise.all(
      todo.map(async (i) => waitingFor(data, dependsOn((await this.deps.backlog.readTicketCached(i)).description, i.id)).length > 0),
    );
    return todo.filter((_, n) => waits[n]).map((i) => i.id);
  }

  /** Starts work on the next item, while there's room for another agent. */
  async tick(): Promise<void> {
    if (this.ticking || !this.enabled || !this.deps.leader.isLeader) return;
    this.ticking = true;
    let memoryWait = false;
    try {
      const was = this.waitingUntil?.getTime();
      this.waitingUntil = await this.deps.reviews.pausedUntil();
      if (this.waitingUntil?.getTime() !== was) this.changed.fire();
      if (this.waitingUntil) return;
      while (this.enabled && this.deps.reviews.canStartNew()) {
        const data = await this.deps.backlog.read();
        const item = nextForAutopilot(data, new Set([...this.failed, ...(await this.waiting(data))]));
        if (!item) return;
        // Too little memory for another agent: this one waits, and the next tick tries again.
        if (memoryShortage()) {
          memoryWait = true;
          return;
        }
        // Admitted before the start's awaits (preparing the worktree takes a while): its slot and memory are reserved, so
        // a start meanwhile sees them.
        const slot = this.deps.reviews.admitNew(item.id);
        if (slot === undefined) return;
        await this.start(item, slot);
        this.changed.fire();
      }
    } finally {
      this.ticking = false;
      if (memoryWait !== this.waitingForMemory) {
        this.waitingForMemory = memoryWait;
        this.changed.fire();
      }
    }
  }

  /** Starts an agent on the item; `slot` is its admitted start (see ReviewLoop.admitNew), given back if the start fails. */
  private async start(item: BacklogItem, slot: number): Promise<void> {
    try {
      const ws = await this.deps.prepareWorktree(item);
      if (!ws) throw new Error('it has no worktree free for an agent (one of its worktrees is in use, or its branch is checked out elsewhere).');
      const fresh = (await this.deps.backlog.read()).items.find((i) => i.id === item.id) ?? item;
      // Preparing the worktree moved it to In Progress: if it's moved on since (the user did), the start is given up.
      if (fresh.status !== 'doing') {
        this.deps.reviews.giveBack(slot);
        await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: 'The autopilot gave up its start: the ticket moved on while its worktree was prepared.' });
        return;
      }
      await this.deps.reviews.startWork(fresh, ws, slot);
      if (fresh.startFailed) await this.deps.backlog.change((d) => setStartFailed(d, item.id));
    } catch (error) {
      this.deps.reviews.giveBack(slot);
      this.failed.add(item.id);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.output.appendLine(`Autopilot couldn't start ${item.id}: ${message}`);
      const now = new Date();
      await this.deps.backlog.change((d) => setStartFailed(d, item.id, { message, since: now.toISOString() }));
      await this.deps.backlog.appendActivity(item, { date: entryDate(now), author: 'Flotilla', body: `The autopilot couldn't start on it: ${message}` });
    }
  }
}
