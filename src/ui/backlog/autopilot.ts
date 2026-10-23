import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { branchMatches, childrenOf, setStartFailed, type BacklogData, type BacklogItem } from '../../features/backlog/backlog';
import { changedFiles, clashFiles, codeMap, findClash, type Clash, type CodeMap } from '../../features/backlog/codeMap';
import { resolveBase } from '../../features/workstreams/progress';
import { readSettings } from '../settings';
import { entryDate } from '../../features/backlog/ticket';
import type { Leader } from '../../features/backlog/leader';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { dependsOn, waitingFor } from '../../features/backlog/mainDrift';
import type { Workstream } from '../../features/workstreams/workstream';
import type { ReviewLoop } from './reviewLoop';
import type { PauseAll } from './pauseAll';
import type { AutopilotAgent, AutopilotQueued } from '../../webview/protocol';
import { memoryShortage } from './agentRunner';
import { recordEvent } from '../../features/metrics/events';
import { awayLine, finished, idleReason, wasOvernight } from '../../features/backlog/autopilotIdle';

/** The autopilot's switch, shared by every window (in the backlog's folder). */
export const AUTOPILOT_FILE = 'autopilot.json';

export interface AutopilotDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  reviews: ReviewLoop;
  leader: Leader;
  output: vscode.OutputChannel;
  /** Pause All (BL-160): while it holds, the autopilot starts nothing (it stays on). */
  pauseAll?: Pick<PauseAll, 'pausedCount' | 'onDidChange'>;
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
  /** When Try Now last found the limit still there (ISO 8601), while it waits on. */
  triedAt?: string;
  /** Waiting for free memory: too little to start an agent (flotilla.agents.minFreeMemoryMB). */
  waitingForMemory?: boolean;
  /** Another window runs it. */
  elsewhere: boolean;
  /** Why it starts nothing though a slot is free (BL-142): "BL-130 waits for BL-126 (in review)", "nothing left in To Do". */
  idle?: string;
  /** What it did while the user was away, for a while after they're back: "Overnight: 6 tickets done, 3 waiting for you". */
  away?: string;
  /** Pause All holds every agent (BL-160): how many it paused. Shown with the autopilot off too. */
  pausedAll?: number;
  /** The agents working now, and the starts waiting in order (BL-153). */
  agents?: AutopilotAgent[];
  queue?: AutopilotQueued[];
}

/** How long it's idle, with tickets waiting, before a notification says so (once). */
const IDLE_NOTICE_MS = 30 * 60_000;
/** An absence shorter than this gets no "while you were away" line; the line stays this long after the return, too. */
const AWAY_MS = 60 * 60_000;

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
  /** When Try Now last found the limit still there: shown while it waits on. */
  private triedAt: Date | undefined;
  /** Why it starts nothing (BL-142), since when, and whether a notification said so. */
  private idle: string | undefined;
  private idleSince: number | undefined;
  private idleNoticed = false;
  /** The window lost focus (when, and the tickets through then); the line for the return, until when. */
  private awayFrom: { at: Date; finished: Set<string> } | undefined;
  private away: { line: string; until: number } | undefined;

  constructor(private readonly deps: AutopilotDeps) {
    const watch = deps.backlog.watch(() => void this.refresh().then(() => this.tick()));
    const timer = setInterval(() => void this.tick(), 30_000);
    this.subscriptions.push({ dispose: () => watch.dispose() }, { dispose: () => clearInterval(timer) }, this.changed);
    const focus = vscode.window.onDidChangeWindowState((s) => void this.focused(s.focused));
    this.subscriptions.push(focus);
    if (deps.pauseAll)
      this.subscriptions.push(
        deps.pauseAll.onDidChange(() => {
          this.changed.fire();
          void this.tick();
        }),
      );
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
      ...(this.waitingUntil && this.waitingUntil.getTime() > Date.now()
        ? { waitingUntil: this.waitingUntil.toISOString(), ...(this.triedAt ? { triedAt: this.triedAt.toISOString() } : {}) }
        : {}),
      ...(this.waitingForMemory ? { waitingForMemory: true } : {}),
      elsewhere: !this.deps.leader.isLeader,
      ...(this.idle ? { idle: this.idle } : {}),
      ...(this.away && this.away.until > Date.now() ? { away: this.away.line } : {}),
      ...(this.deps.pauseAll?.pausedCount !== undefined ? { pausedAll: this.deps.pauseAll.pausedCount } : {}),
      agents: this.deps.reviews.agentsNow(),
      queue: this.deps.reviews.queuedStarts(),
    };
  }

  /** The window lost or got focus: on the return after a while, what the autopilot got done meanwhile. */
  async focused(focused: boolean, now = new Date()): Promise<void> {
    if (!focused) {
      if (this.enabled && !this.awayFrom) this.awayFrom = { at: now, finished: finished(await this.deps.backlog.read()) };
      return;
    }
    const from = this.awayFrom;
    this.awayFrom = undefined;
    if (!from || !this.enabled || now.getTime() - from.at.getTime() < AWAY_MS) return;
    const line = awayLine(from.finished, await this.deps.backlog.read(), wasOvernight(from.at, now));
    if (!line) return;
    this.away = { line, until: now.getTime() + AWAY_MS };
    this.changed.fire();
  }

  /** Notes why it's idle; after half an hour of it with tickets waiting, a notification says so, once. */
  private setIdle(reason: string | undefined, now = Date.now()): void {
    // Idle only with no agent at work; tickets wait unless nothing is left.
    const waits = reason !== undefined && reason !== 'nothing left in To Do' && this.deps.reviews.running === 0;
    if (!waits) {
      this.idleSince = undefined;
      this.idleNoticed = false;
    } else if (this.idleSince === undefined) this.idleSince = now;
    else if (!this.idleNoticed && now - this.idleSince >= IDLE_NOTICE_MS) {
      this.idleNoticed = true;
      void vscode.window.showInformationMessage(`The autopilot has been idle for ${Math.round((now - this.idleSince) / 60_000)} minutes: ${reason}.`);
    }
    if (reason !== this.idle) {
      if (reason !== undefined) recordEvent('autopilot-idle', { data: { reason } });
      this.idle = reason;
      this.changed.fire();
    }
  }

  /** The To Do tickets held back because they'd change files a ticket in progress changes (BL-71), as of the last tick. */
  private clashes = new Map<string, Clash>();
  /** Maps of To Do tickets, by id: kept while the backlog and the ticket stay as they were (at most 10 minutes). */
  private readonly maps = new Map<string, { key: string; at: number; map: CodeMap }>();
  /** The holds noted in their tickets ("BL-7>BL-3"): each once. */
  private readonly noted = new Set<string>();

  /** Why a To Do ticket waits for another one in progress (BL-71), if it does. */
  clashOf(id: string): Clash | undefined {
    return this.clashes.get(id);
  }

  /**
   * The To Do tickets whose map is firm about files a ticket in progress changes (BL-71): they wait for it, so their
   * work isn't built on code about to change under it (and done again after the merge). Only with
   * flotilla.autopilot.avoidClashes on: off by default (BL-142), tickets wait only for what they say they depend on.
   */
  private async clashing(data: BacklogData): Promise<Map<string, Clash>> {
    const found = new Map<string, Clash>();
    // Without the repository's worktrees (yet), there's nothing to compare.
    const main = this.deps.repository?.current.find((w) => w.worktree.isMain)?.worktree.path;
    if (!main || !vscode.workspace.getConfiguration('flotilla').get<boolean>('autopilot.avoidClashes', false)) return found;
    const todo = data.items.filter((i) => i.status === 'todo' && !i.proposed && !i.shaping);
    const active = data.items.filter((i) => i.status === 'doing' || i.status === 'review');
    if (!todo.length || !active.length) return found;
    const base = (await resolveBase(main, readSettings().defaultBase)) ?? 'HEAD';
    const busy = new Map<string, Set<string>>();
    for (const item of active) {
      const files = new Set<string>();
      for (const w of this.deps.repository.current) {
        if (w.worktree.isMain || !w.worktree.path || !w.worktree.branch || !branchMatches(item, w.worktree.branch)) continue;
        for (const f of await changedFiles(w.worktree.path, base)) files.add(f);
      }
      if (files.size) busy.set(item.id, files);
    }
    for (const item of todo) {
      const map = await this.mapOf(item, data, main);
      const clash = map && findClash(map.firm, busy, item.id);
      if (clash) found.set(item.id, clash);
    }
    return found;
  }

  private async mapOf(item: BacklogItem, data: BacklogData, main: string): Promise<CodeMap | undefined> {
    const ticket = await this.deps.backlog.readTicketCached(item);
    const key = JSON.stringify([ticket.description, item.parent, data.items.map((i) => [i.id, i.status, i.parent])]);
    const known = this.maps.get(item.id);
    if (known && known.key === key && Date.now() - known.at < 10 * 60_000) return known.map;
    const map = await codeMap(main, item, ticket.description, data.items).catch(() => undefined);
    if (map) this.maps.set(item.id, { key, at: Date.now(), map });
    return map;
  }

  /** Notes a new hold in its ticket, once (also across reloads: a hold the ticket already notes isn't noted again). */
  private async noteClashes(data: BacklogData): Promise<void> {
    for (const [id, clash] of this.clashes) {
      if (this.noted.has(`${id}>${clash.with}`)) continue;
      this.noted.add(`${id}>${clash.with}`);
      const item = data.items.find((i) => i.id === id);
      if (!item) continue;
      const lead = `The autopilot holds it back: it would change`;
      const tail = `which ${clash.with} (in progress) changes too.`;
      const { activity } = await this.deps.backlog.readTicketCached(item);
      if (activity.some((e) => e.author === 'Flotilla' && e.body.startsWith(lead) && e.body.includes(tail))) continue;
      await this.deps.backlog.appendActivity(item, {
        date: entryDate(new Date()),
        author: 'Flotilla',
        body: `${lead} ${clashFiles(clash)}, ${tail} It starts once ${clash.with} is merged, so its work builds on that; start it yourself to go ahead anyway.`,
      });
    }
  }

  /** The To Do tickets that wait for others to be merged ("Depends on: BL-12" in their description, BL-55), and for which. */
  private async waiting(data: BacklogData): Promise<Map<string, string[]>> {
    const todo = data.items.filter((i) => i.status === 'todo' && !i.proposed);
    const waits = await Promise.all(
      todo.map(async (i) => waitingFor(data, dependsOn((await this.deps.backlog.readTicketCached(i)).description, i.id)).map((d) => d.id)),
    );
    return new Map(todo.flatMap((i, n) => (waits[n].length ? [[i.id, waits[n]] as const] : [])));
  }

  /**
   * Try Now (BL-132): the agents paused on a usage limit go on now if Claude takes work again (see
   * ReviewLoop.tryPausedNow), and the autopilot takes To Do tickets again; if it doesn't, it waits on, and says when it
   * tried. Its switch stays as it is.
   */
  async tryNow(): Promise<Awaited<ReturnType<ReviewLoop['tryPausedNow']>>> {
    const result = await this.deps.reviews.tryPausedNow();
    this.triedAt = result?.limited ? result.tried : undefined;
    this.waitingUntil = await this.deps.reviews.pausedUntil();
    this.changed.fire();
    await this.tick();
    return result;
  }

  /** Starts work on the next item, while there's room for another agent. */
  async tick(): Promise<void> {
    if (this.ticking || !this.enabled || !this.deps.leader.isLeader || this.deps.pauseAll?.pausedCount !== undefined) return;
    this.ticking = true;
    let memoryWait = false;
    let idle: string | undefined;
    try {
      const was = this.waitingUntil?.getTime();
      this.waitingUntil = await this.deps.reviews.pausedUntil();
      if (!this.waitingUntil) this.triedAt = undefined;
      if (this.waitingUntil?.getTime() !== was) this.changed.fire();
      if (this.waitingUntil) return;
      while (this.enabled && this.deps.reviews.canStartNew()) {
        const data = await this.deps.backlog.read();
        const clashes = await this.clashing(data);
        const changed = JSON.stringify([...clashes]) !== JSON.stringify([...this.clashes]);
        this.clashes = clashes;
        if (changed) this.changed.fire();
        await this.noteClashes(data);
        const waits = await this.waiting(data);
        const item = nextForAutopilot(data, new Set([...this.failed, ...waits.keys(), ...clashes.keys()]));
        if (!item) {
          idle = clashes.size ? undefined : idleReason(data, waits, this.failed);
          return;
        }
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
      this.setIdle(idle);
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
      await this.deps.reviews.startWork(fresh, ws, { slot });
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
