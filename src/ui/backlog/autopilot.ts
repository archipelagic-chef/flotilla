import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { childrenOf, type BacklogData, type BacklogItem } from '../../features/backlog/backlog';
import { entryDate } from '../../features/backlog/ticket';
import type { Leader } from '../../features/backlog/leader';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { Workstream } from '../../features/workstreams/workstream';
import type { ReviewLoop } from './reviewLoop';

/** The autopilot's switch, shared by every window (in the backlog's folder). */
export const AUTOPILOT_FILE = 'autopilot.json';

export interface AutopilotDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  reviews: ReviewLoop;
  leader: Leader;
  output: vscode.OutputChannel;
  /** A worktree for an item, ready for an agent (created without asking; undefined if it can't be). */
  prepareWorktree(item: BacklogItem): Promise<Workstream | undefined>;
}

/** What the backlog view shows of the autopilot. */
export interface AutopilotView {
  enabled: boolean;
  /** Agents working for it now, and the most at once. */
  running: number;
  max: number;
  /** Waiting for Claude's usage limit to reset (ISO 8601). */
  waitingUntil?: string;
  /** Another window runs it. */
  elsewhere: boolean;
}

/** The next items the autopilot takes: To Do, accepted, in the backlog's order; an epic's parts, not the epic. */
export function nextForAutopilot(data: BacklogData, skip: ReadonlySet<string>): BacklogItem | undefined {
  return data.items.find((i) => i.status === 'todo' && !i.proposed && !skip.has(i.id) && childrenOf(data, i.id).length === 0);
}

/**
 * The autopilot: while it's on, agents take the backlog's To Do items in order and work on them without a window, up
 * to flotilla.autopilot.maxAgents at once: a worktree each, In Progress, reports in the ticket; their "Ready for
 * review." goes on to review. On a usage limit no new work starts until it resets (the paused agents go on then). Only
 * the leading window runs it.
 */
export class Autopilot implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Items it couldn't start (this session): not tried again. */
  private readonly failed = new Set<string>();
  private ticking = false;
  private waitingUntil: Date | undefined;

  constructor(private readonly deps: AutopilotDeps) {
    const watch = deps.backlog.watch(() => {
      this.changed.fire();
      void this.tick();
    });
    const timer = setInterval(() => void this.tick(), 30_000);
    this.subscriptions.push({ dispose: () => watch.dispose() }, { dispose: () => clearInterval(timer) }, this.changed);
    void this.tick();
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
  }

  private get file(): string {
    return path.join(this.deps.backlog.dir, AUTOPILOT_FILE);
  }

  get enabled(): boolean {
    try {
      return (JSON.parse(fs.readFileSync(this.file, 'utf8')) as { enabled?: unknown }).enabled === true;
    } catch {
      return false;
    }
  }

  private get max(): number {
    return Math.max(1, vscode.workspace.getConfiguration('flotilla').get<number>('autopilot.maxAgents', 2));
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.backlog.ensureDir();
    await fs.promises.writeFile(this.file, `${JSON.stringify({ enabled }, null, 1)}\n`);
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
      max: this.max,
      ...(this.waitingUntil && this.waitingUntil.getTime() > Date.now() ? { waitingUntil: this.waitingUntil.toISOString() } : {}),
      elsewhere: !this.deps.leader.isLeader,
    };
  }

  /** Starts work on the next item, while there's room for another agent. */
  async tick(): Promise<void> {
    if (this.ticking || !this.enabled || !this.deps.leader.isLeader) return;
    this.ticking = true;
    try {
      const was = this.waitingUntil?.getTime();
      this.waitingUntil = await this.deps.reviews.pausedUntil();
      if (this.waitingUntil?.getTime() !== was) this.changed.fire();
      if (this.waitingUntil) return;
      while (this.enabled && this.deps.reviews.running < this.max) {
        const item = nextForAutopilot(await this.deps.backlog.read(), this.failed);
        if (!item) return;
        await this.start(item);
        this.changed.fire();
      }
    } finally {
      this.ticking = false;
    }
  }

  private async start(item: BacklogItem): Promise<void> {
    try {
      const ws = await this.deps.prepareWorktree(item);
      if (!ws) throw new Error('it has no worktree free for an agent (one of its worktrees is in use, or its branch is checked out elsewhere).');
      const fresh = (await this.deps.backlog.read()).items.find((i) => i.id === item.id) ?? item;
      await this.deps.reviews.startWork(fresh, ws);
    } catch (error) {
      this.failed.add(item.id);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.output.appendLine(`Autopilot couldn't start ${item.id}: ${message}`);
      await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body: `The autopilot couldn't start on it: ${message}` });
    }
  }
}
