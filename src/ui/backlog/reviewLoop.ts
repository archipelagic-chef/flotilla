import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import {
  agentChatItem,
  agentLead,
  agentName,
  type BacklogItem,
  type BacklogStatus,
  branchMatches,
  entryAgent,
  sameAgent,
  updateItem,
} from '../../features/backlog/backlog';
import { isDiscussionChat } from '../../features/backlog/shaping';
import { GUIDE } from '../../features/backlog/inbox';
import { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  mayStartNow,
  ordinal,
  pauseOrder,
  prioritizeAction,
  type StartKind,
  StartQueue,
  type WaitingStart,
} from '../../features/backlog/agentQueue';
import {
  answerPrompt,
  AUTOPILOT_NOTE,
  HAND_START_NOTE,
  type HeldAgent,
  heldAt,
  heldBy,
  readyReport,
  resumeAfterLimitPrompt,
  resumeAfterPausePrompt,
  resumeAfterUserPausePrompt,
  resumeAskingPrompt,
  reviewerPrompt,
  type ReviewFix,
  type ReviewState,
  type ReviewStopKind,
  revisionPrompt,
  type RevisionTask,
  saysWaitingForUser,
  stampWaiting,
  startedInTerminal,
  takeOverPrompt,
  userAnswer,
  userReviewBody,
  userRevisionPrompt,
  type Verdict,
  verdictReport,
} from '../../features/backlog/review';
import { entryDate, type TicketEntry } from '../../features/backlog/ticket';
import {
  movedUp,
  moveUpTarget,
  ROUNDS_BEFORE_MOVING_UP,
  strongerRequest,
} from '../../features/backlog/modelLevel';
import { NO_USAGE, runawayPrompt, runawayReason } from '../../features/backlog/runaway';
import { mapFor } from '../../features/backlog/codeMap';
import { readTranscript, type ChatUsage } from '../../features/chats/chats';
import { transcriptBusy } from '../../features/backlog/busy';
import { transcriptPath } from '../../features/chats/chats';
import { retryDelay, type UsageLimit } from '../../features/backlog/limits';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { agentPrompt } from '../commands';
import { workstreamLabel } from '../format';
import { formatMemory } from '../../features/workstreams/memory';
import { readSettings } from '../settings';
import { staleVersionNote } from '../installedVersion';
import {
  agentChoice,
  type AgentResult,
  type AgentRun,
  confirmMemory,
  describeChoice,
  isRunningHeadless,
  isRunningInTerminal,
  isWorkingHere,
  memoryShortage,
  modelLevels,
  probeLimit,
  releaseStart,
  reserveStart,
  runAgentHeadless,
  runAgentInTerminal,
  stopTerminalAgent,
  validSession,
} from './agentRunner';
import type { QueuedView } from '../../webview/ticketProtocol';
import type { AutopilotAgent, AutopilotQueued } from '../../webview/protocol';
import { trackProgress } from '../progress';
import { recordEvent } from '../../features/metrics/events';
import { resumeAsk } from '../../features/backlog/needs';

export interface ReviewDeps {
  /** Whether this window acts on its own (agents going on after a usage limit): one window does. */
  isLeader?(): boolean;
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  mainRoot: string;
  output: vscode.OutputChannel;
  /** An item was approved: by the reviewer agent (its name), or by the user (undefined). */
  onApproved?(id: string, by: string | undefined): void;
  /** Whether Pause All holds every agent (BL-160): nothing starts on its own, starts wait in the queue. */
  pausedAll?(): boolean;
  /** Claude takes work again (the limit the paused agents wait on lifted): the note agents waiting on it go on too (BL-203). */
  limitLifted?(): void;
}

const settings = () => vscode.workspace.getConfiguration('flotilla');

/** Why a resume of an agent that stopped to go on later starts (BL-198): its note says it was resumed, not answered. */
const RESUMED = 'you resumed it';

/** The item's state that decides whether a start still applies: its status and review (see admitStart). */
const stateOf = (item: BacklogItem) => JSON.stringify([item.status, item.review?.state, item.review?.round, item.review?.implementer ?? null]);

/** A start that was admitted (see admitStart): its reserved slot (see reserveStart), and the item's state then (see stateOf). */
interface Admitted {
  slot: number;
  since: string;
}

/**
 * How a start is asked for: `manual` (the user asked: it runs at once, see admitStart), `dispatched` (it's at the head of
 * the queue: nothing is ahead of it), `reply` (the user's reply, an answer or requested changes: queued like any start,
 * but ahead of the other kinds).
 */
interface StartOptions {
  manual?: boolean;
  /** Resume All's (BL-160): it runs while Pause All still holds, ahead of the queue, but within the limit. */
  all?: boolean;
  dispatched?: boolean;
  reply?: boolean;
}

/** A run of an agent this window started without a window: for the pick Prioritize pauses. */
interface Running {
  run: AgentRun;
  phase: 'review' | 'work';
  agent: string;
  /** Where it runs: its transcript is found from it (see transcriptPath). */
  cwd: string;
  since: number;
  /** Its chat's token use when it started (a resumed chat's earlier turns don't count against it, see watchRunaways). */
  base?: ChatUsage;
}

/** The start that waits: runs with the item as it is then. */
type StartFn = (item: BacklogItem) => Promise<void>;

/** How long a chat that should be at work stays still before its agent counts as lost (see recoverLost). */
const LOST_AFTER_MS = 2 * 60_000;

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
/** Pauses in the order they began (the oldest first): the order they go on in when their limit lifts (BL-179). */
const oldestFirst = <T extends { p: { since?: string; until?: string } }>(group: T[]): T[] =>
  [...group].sort((a, b) => Date.parse(a.p.since ?? a.p.until ?? '') - Date.parse(b.p.since ?? b.p.until ?? ''));

/**
 * Runs the review loop (see review.ts) for local items: an item entering In Review gets a reviewer agent; its verdict
 * sends the item back to its implementer, or ends the loop. Agents run without a window (claude -p); their chats can be
 * opened from the ticket. Only moves seen while Flotilla runs start a review; Start Review starts one by hand.
 */
export class ReviewLoop implements vscode.Disposable {
  /** Each item's status when last seen: a move into review starts a round. */
  private readonly statuses = new Map<string, BacklogStatus>();
  /** Reports already there when Flotilla first saw an item: old news, not acted on. */
  private readonly baseline = new Map<string, string[]>();
  /** The agent running for an item (reviewer or implementer). */
  private readonly runs = new Map<string, Running>();
  /**
   * The starts admitted but not spawned yet (see admitStart): their reserved slots, and the items they're for. Each holds
   * its agent slot (see running) and its memory (see reserveStart) until its agent spawns, or it's given up (see release).
   */
  private readonly starting = new Map<number, string>();
  /**
   * The starts waiting for a free agent slot or for memory (see agentQueue.ts). Each runs with the item as it is then;
   * its `since` (the item's state when it was decided) must still hold, or the start is dropped.
   */
  private readonly waiting = new StartQueue<StartFn>();
  /** The item whose queued start Prioritize is running now: it may start above the limit (see roomFor). */
  private priority: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly watcher: vscode.Disposable;
  private readonly repoWatcher: vscode.Disposable;
  /** An item's review changed, or its place in the queue (by its id). */
  private readonly changed = new vscode.EventEmitter<string>();
  readonly onDidChange = this.changed.event;
  /** The agents agentsNow lists (and running counts) changed: an agent spawned, a run ended, a chat started or ended (BL-201). */
  private readonly agentsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeAgents = this.agentsChanged.event;
  private agentsKey = '[]';
  private agentsNoted = false;

  /** Fires onDidChangeAgents if agentsNow changed, once the change under way is done (a run dropped and ended, say). */
  private noteAgents(): void {
    if (this.agentsNoted) return;
    this.agentsNoted = true;
    queueMicrotask(() => {
      this.agentsNoted = false;
      try {
        const key = JSON.stringify(this.agentsNow());
        if (key === this.agentsKey) return;
        this.agentsKey = key;
        this.agentsChanged.fire();
      } catch (e) {
        this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  constructor(private readonly deps: ReviewDeps) {
    this.watcher = deps.backlog.watch(() => this.schedule());
    // A chat that ends (a window's agent) frees a slot too: the queue looks again.
    this.repoWatcher = deps.repository.onDidChange(() => {
      this.noteAgents();
      this.scheduleDispatch();
    });
    this.schedule();
    // Agents paused on a usage limit go on when it resets, and waiting starts go on when there's room (each minute: a
    // sleeping computer skips timers).
    this.ticker = setInterval(() => this.scheduleRetry(), 60_000);
  }

  /** Retries run in the same queue as the scans: they read and write backlog.json too. */
  private scheduleRetry(): void {
    this.queue = this.queue.then(() => this.retry());
  }

  /** Once a minute: paused agents whose limit has reset go on, and waiting starts go on when there's room. */
  private async retry(): Promise<void> {
    try {
      await this.resumePaused();
      await this.recoverLost();
      await this.watchRunaways();
      await this.dispatch();
    } catch (e: unknown) {
      this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private readonly ticker: NodeJS.Timeout;
  private resumeTimer: NodeJS.Timeout | undefined;

  dispose(): void {
    this.watcher.dispose();
    this.repoWatcher.dispose();
    clearInterval(this.ticker);
    clearTimeout(this.resumeTimer);
    this.runs.forEach((r) => r.run.stop());
    this.changed.dispose();
    this.agentsChanged.dispose();
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /** One scan at a time: they read and write backlog.json. */
  private schedule(): void {
    this.queue = this.queue
      .then(() => this.scan())
      .catch((e: unknown) => this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`));
  }

  private key = (id: string) => (e: TicketEntry) => LocalBacklog.entryKey(id, e);

  private async scan(): Promise<void> {
    const data = await this.deps.backlog.read();
    const automatic = settings().get<boolean>('review.automatic', true);
    // The sessions the user paused or stopped: they don't take a slot, whatever their chats still say (see running).
    this.held = new Map(
      data.items.flatMap((i) => {
        const held = heldBy(i.review);
        return held ? [[held.session, i.review?.state === 'paused' ? 'paused' : 'stopped'] as const] : [];
      }),
    );
    this.noteAgents();
    for (const item of data.items) {
      const before = this.statuses.get(item.id);
      this.statuses.set(item.id, item.status);
      // An agent the user paused or stopped (in any window) that runs here ends.
      const held = heldBy(item.review);
      if (held && this.heldRunsHere(item.id, held.session, heldAt(item.review))) await this.end(item.id, held.session);
      if (before === undefined) {
        const ticket = await this.deps.backlog.readTicket(item);
        this.baseline.set(item.id, ticket.activity.map(this.key(item.id)));
        continue;
      }
      if (this.runs.has(item.id) || item.proposed) continue;
      // The implementer asked the user something: their comment answers it, and it goes on.
      if (item.review?.state === 'asking') {
        const ticket = await this.deps.backlog.readTicket(item);
        const answer = userAnswer(ticket.activity, item.review, this.key(item.id));
        if (answer.length) await this.answer(item, answer.map((e) => e.body).join('\n\n'), answer.map(this.key(item.id)));
        continue;
      }
      // Its agent says the work needs a stronger model: it moves up, and a loop's agent goes on in its chat (BL-69).
      if ((item.status === 'doing' || item.status === 'todo') && moveUpTarget(item.agent, modelLevels())) {
        const ticket = await this.deps.backlog.readTicket(item);
        const asks = strongerRequest(ticket.activity, [...(item.review?.handled ?? []), ...(this.baseline.get(item.id) ?? [])], this.key(item.id));
        if (asks) {
          const inLoop = item.review?.state === 'revising' || item.review?.state === 'working';
          const moved = await this.moveUp(
            item.id,
            `${asks.agent} said the work needs a stronger model`,
            inLoop ? undefined : ' Start an agent again to go on with it.',
          );
          if (moved && inLoop)
            await this.startRevision(moved, {
              prompt: `You now run on ${moved.agent!.model}, a stronger model. Go on where you left off, then report in the ticket as asked.`,
              why: 'it needs a stronger model',
              aside: true,
            });
          continue;
        }
      }
      // Changes the user asked for come back to the user, whether reviewer agents run or not.
      const byUser = !!item.review?.byUser && item.review.state === 'revising';
      // The autopilot's work goes on to review too: to the reviewer agent, or (without automatic reviews) to the user.
      const autopilot = item.review?.state === 'working';
      const toUser = byUser || (autopilot && !automatic);
      if (!automatic && !byUser && !autopilot) continue;
      // An implementer that reports "Ready for review" sends its item to review.
      if (item.status === 'doing' || item.status === 'todo') {
        const ticket = await this.deps.backlog.readTicket(item);
        const seen = {
          ...(item.review ?? { round: 0, state: 'revising' as const, reviewer: '' }),
          handled: [...(item.review?.handled ?? []), ...(this.baseline.get(item.id) ?? [])],
        };
        const ready = readyReport(ticket.activity, seen, this.key(item.id));
        if (ready) {
          if (toUser) this.statuses.set(item.id, 'review');
          await this.setReview(
            item.id,
            (r) => ({
              ...(r ?? { round: 0, state: 'revising', reviewer: '' }),
              ...(toUser ? { state: 'yours' as const } : {}),
              implementer: r?.implementer ?? ready.agent,
              handled: [...(r?.handled ?? []), this.key(item.id)(ready.entry)],
            }),
            'review',
            `Agent ${ready.agent}`,
          );
          continue;
        }
      }
      if (automatic && item.status === 'review' && before !== 'review' && item.review?.state !== 'reviewing' && item.review?.state !== 'yours')
        await this.start(item.id);
    }
  }

  /**
   * Admits a start: the one way an agent starts. Called before the start's work (its awaits): the caller's copy of the
   * item must match the stored one (a start decided on a stale copy is given up), and a manual start asks about memory
   * when it's short (Start Anyway starts it). Then, with no await in between, there must be room (see roomFor), and the
   * start's slot and memory are reserved (see take): from here it counts as running and against the free memory, so a
   * start checked meanwhile sees it. The caller hands the slot to runAgentHeadless, or gives it back (release) when the
   * start is given up. A start that may not run yet waits in the queue: `start` runs it later, with the item as it is
   * then. Undefined when it waits, is given up, or the item is gone.
   */
  private async admitStart(item: BacklogItem, kind: StartKind, o: StartOptions, start: StartFn): Promise<Admitted | undefined> {
    const stored = (await this.deps.backlog.read()).items.find((i) => i.id === item.id);
    if (!stored) return undefined;
    const since = stateOf(stored);
    // Decided on an item the ticket no longer matches (it moved on since the caller read it): the start is given up.
    if (stateOf(item) !== since) {
      await this.note(item.id, 'The start is given up: the ticket changed before it could start.');
      return undefined;
    }
    // A queued start the user stopped or answered meanwhile (that takes it out of the queue) isn't run.
    if (o.dispatched && !this.waiting.has(item.id)) return undefined;
    if (o.manual && memoryShortage()) {
      // Asked when the user starts it; a start of theirs that waited for memory waits on while it's short.
      if (o.dispatched || !(await confirmMemory(`The agent for ${item.id}`))) {
        await this.wait(item, kind, o, start);
        return undefined;
      }
    }
    // An agent runs for it already: this start isn't needed. (Two starts on their way for one item can't both spawn: each
    // checks for a run, and for the item's state, right before its agent starts.)
    if (this.runs.has(item.id)) return undefined;
    if (!this.roomFor(item, kind, o, start)) return undefined;
    return { slot: this.take(item.id), since };
  }

  /**
   * Whether a start may run now (see mayStartNow): a manual one runs (its memory was asked about, see admitStart); others
   * need a free slot, enough memory (the admitted starts count, see take) and nothing ahead of them in the queue. A
   * prioritized start may go above the limit and ahead of the queue, but not when memory is short. A start that may not
   * run waits in the queue.
   */
  private roomFor(item: BacklogItem, kind: StartKind, o: StartOptions, start: StartFn): boolean {
    const prioritized = this.priority === item.id;
    // While Pause All holds, only the user's own starts run (BL-160).
    const may =
      (!!o.manual || !!o.all || !this.deps.pausedAll?.()) &&
      mayStartNow({
        manual: !!o.manual,
        running: this.running,
        limit: prioritized ? Number.POSITIVE_INFINITY : this.limit,
        ahead: o.dispatched || prioritized || o.all ? 0 : this.waiting.size,
        memoryShort: !!memoryShortage(),
      });
    if (!may)
      void this.wait(item, kind, o, start).catch((e: unknown) => this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`));
    return may;
  }

  /**
   * Reserves an admitted start's slot and memory (see reserveStart), and takes it out of the queue: it counts as running
   * until its agent spawns (see launched) or it's given up (see release).
   */
  private take(id: string): number {
    const slot = reserveStart();
    this.starting.set(slot, id);
    this.noteAgents();
    if (this.waiting.has(id)) {
      this.waiting.remove(id);
      this.fireQueue(id);
    }
    return slot;
  }

  /** An admitted start's agent has spawned (runAgentHeadless took its reserved memory over): it runs now. */
  private launched(id: string, slot: number, live: Running): void {
    this.starting.delete(slot);
    this.runs.set(id, live);
    this.noteAgents();
    // A run that goes on in a session this window ended before (a revision, a later round, a limit resume) works again (BL-199).
    this.ended.delete(live.run.sessionId);
    void readTranscript(live.cwd, live.run.sessionId)
      .catch(() => undefined)
      .then((t) => (live.base = t?.usage ?? NO_USAGE));
  }

  /**
   * Once a minute: an agent going round in circles (the same command failing again and again, nothing changed in
   * between) or past flotilla.agents.tokenBudget since it started is stopped, and its ticket asks the user (BL-76).
   */
  private async watchRunaways(): Promise<void> {
    const budget = Math.max(0, settings().get<number>('agents.tokenBudget', 25)) * 1_000_000;
    for (const [id, live] of [...this.runs]) {
      if (!live.base) continue;
      const usage = (await readTranscript(live.cwd, live.run.sessionId).catch(() => undefined))?.usage;
      const why = usage && runawayReason(usage, live.base, budget);
      if (!why || this.runs.get(id) !== live) continue;
      this.runs.delete(id);
      this.noteAgents();
      this.ended.add(live.run.sessionId);
      live.run.stop();
      this.scheduleDispatch();
      const task: RevisionTask | undefined = live.phase === 'work' ? { prompt: runawayPrompt(why), why: `${live.agent} was stopped`, aside: true } : undefined;
      await this.stopLoop(id, `${live.agent} was stopped: ${why}. Resume it to go on (it's asked to step back first), or hand it to a new agent.`, {
        kind: 'runaway',
        task,
      });
    }
  }

  /** Gives back the slot and memory of an admitted start that was given up before its agent spawned. */
  private release(slot: number): void {
    releaseStart(slot);
    const had = this.starting.delete(slot);
    this.noteAgents();
    if (!had) return;
    this.scheduleDispatch();
  }

  /** Puts a start in the queue: it runs when there's room (a slot and memory), with the item as it is then. */
  private async wait(item: BacklogItem, kind: StartKind, o: StartOptions, start: StartFn): Promise<void> {
    const before = this.waiting.get(item.id);
    const short = memoryShortage();
    // An agent paused to make room keeps its head of the queue, however often it waits again (see pauseFor).
    this.waiting.add({
      id: item.id,
      kind,
      manual: !!o.manual,
      reason: short ? 'memory' : 'slot',
      since: stateOf(item),
      at: before?.at ?? Date.now(),
      // So is one paused on a limit that lifted: those go on before any other work (BL-179).
      front: !!item.review?.paused?.for || (kind === 'resume' && !!item.review?.paused && !item.review.paused.byUser),
      start,
    });
    this.fireQueue(item.id);
    if (before) return;
    const place = ordinal(this.waiting.place(item.id) ?? 1);
    await this.note(
      item.id,
      short
        ? `Queued: an agent takes this up when there's free memory (${place} in line).`
        : `Queued: an agent takes this up when one is free (${place} in line).`,
    );
  }

  /**
   * Starts the waiting starts, in order, while there's room for each: a manual one runs whatever the limit, an automatic
   * one needs a free slot. Nothing starts while memory is short (the admitted starts count, see take).
   */
  private async dispatch(): Promise<void> {
    if (this.deps.pausedAll?.()) return;
    for (const w of this.waiting.ordered()) {
      if (memoryShortage()) break;
      if (!w.manual && this.running >= this.limit) continue;
      await this.runWaiting(w);
    }
    this.fireQueue();
  }

  /** Runs a waiting start: admitted, it leaves the queue (see take); if it may not run yet, it waits on (see roomFor). */
  private async runWaiting(w: WaitingStart<StartFn>): Promise<void> {
    // Read while the entry is still queued: if the read fails, the start stays queued for the next try.
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === w.id);
    // The read may have waited while the user stopped the item or answered it (that takes the entry out): then it's
    // not this start any more, and it's not run. A replaced entry (the item waited again) is run by its own dispatch.
    if (this.waiting.get(w.id) !== w) return;
    // The item moved on, was discarded (BL-210), or an agent runs for it already: the start that waited is over.
    const over = !item || item.proposed || !!item.discarded || this.runs.has(w.id);
    if (over || stateOf(item) !== w.since) {
      this.waiting.remove(w.id);
      this.fireQueue(w.id);
      if (!over) await this.note(w.id, 'The start that waited is dropped: the ticket changed meanwhile.');
      return;
    }
    try {
      await w.start(item);
    } catch (e: unknown) {
      this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // A start that neither ran nor waited again (it stopped the loop, say) leaves the queue.
      if (this.waiting.get(w.id) === w) {
        this.waiting.remove(w.id);
        this.fireQueue(w.id);
      }
    }
    if (this.runs.has(w.id)) await this.note(w.id, 'An agent is on it.');
  }

  /** Pause All's hold is lifted (here, or in another window): the queued starts go on (BL-160). */
  dispatchQueued(): void {
    this.scheduleDispatch();
  }

  /** Starts the queue (after the scan or the run that ended, in the scans' order: they read and write backlog.json). */
  private scheduleDispatch(): void {
    if (this.waiting.size)
      this.queue = this.queue
        .then(() => this.dispatch())
        .catch((e: unknown) => this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The queue changed: the tickets waiting in it (and those given) show their place anew. */
  private fireQueue(...ids: string[]): void {
    for (const id of new Set([...ids, ...this.waiting.ordered().map((w) => w.id)])) this.changed.fire(id);
  }

  /** How many agents may run above the limit, by Prioritize (flotilla.agents.maxPrioritized). */
  get maxPrioritized(): number {
    return Math.max(0, settings().get<number>('agents.maxPrioritized', 2));
  }

  /** The most agents running at once: flotilla.agents.maxRunning, or flotilla.autopilot.maxAgents when the user set that (its older name). */
  get limit(): number {
    const older = settings().inspect<number>('autopilot.maxAgents');
    const set = older?.workspaceFolderValue ?? older?.workspaceValue ?? older?.globalValue;
    return Math.max(1, set ?? settings().get<number>('agents.maxRunning', 2));
  }

  /** Whether an automatic start may begin now: a slot is free, and nothing waits ahead of it. */
  canStartNew(): boolean {
    return this.running < this.limit && this.waiting.size === 0 && !this.deps.pausedAll?.();
  }

  /**
   * Admits a new ticket's start for the autopilot, which prepares its worktree before startWork: a slot free, nothing
   * waiting, and memory enough. Its slot and memory are reserved from now (see take); the autopilot hands the slot to
   * startWork, or gives it back (giveBack). Undefined when there's no room.
   */
  admitNew(id: string): number | undefined {
    if (!this.canStartNew() || memoryShortage() || this.runs.has(id)) return undefined;
    return this.take(id);
  }

  /** Gives back a slot from admitNew: the start was given up before its agent spawned. */
  giveBack(slot: number): void {
    this.release(slot);
  }

  /** The starts waiting (for the autopilot's line). */
  get waitingCount(): number {
    return this.waiting.size;
  }

  /** Where an item's start waits, for its ticket: why, its place in the queue, and the agents running now and the limit. */
  queuedFor(id: string): QueuedView | undefined {
    const w = this.waiting.get(id);
    const place = this.waiting.place(id);
    if (!w || place === undefined) return undefined;
    return { reason: w.reason, place, running: this.running, limit: this.limit, kind: w.kind, ...(w.at ? { since: new Date(w.at).toISOString() } : {}) };
  }

  /** Whether the item is still in the state it had when its start was admitted (`since`, see admitStart). */
  private async unchanged(id: string, since: string): Promise<boolean> {
    const stored = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    return stored !== undefined && stateOf(stored) === since;
  }

  /** Changes an item's review (and status: moved by `by`, noted in its ticket). */
  private async setReview(id: string, change: (r: ReviewState | undefined) => ReviewState, status?: BacklogStatus, by = 'Flotilla'): Promise<void> {
    const now = new Date().toISOString();
    await this.deps.backlog.change(
      (d) => ({
        ...d,
        items: d.items.map((i) => (i.id === id ? { ...i, review: stampWaiting(i.review, change(i.review), now), ...(status ? { status } : {}) } : i)),
      }),
      { by },
    );
    this.changed.fire(id);
  }

  /**
   * Moves a ticket that runs on a weaker model up to the strong one (BL-69), noted with why (and what's next, after).
   * The item as it is then; undefined when it doesn't run on a weaker model (nothing moves down, or on a guess).
   */
  private async moveUp(id: string, reason: string, after = ''): Promise<BacklogItem | undefined> {
    let moved: BacklogItem | undefined;
    await this.deps.backlog.change((d) => ({
      ...d,
      items: d.items.map((i) => {
        const move = i.id === id ? moveUpTarget(i.agent, modelLevels()) : undefined;
        if (!move) return i;
        moved = { ...i, agent: movedUp(i.agent, move, reason, new Date()) };
        return moved;
      }),
    }));
    const m = moved?.agent?.movedUp;
    if (!moved || !m) return undefined;
    await this.note(id, `Moved up from ${m.from} to ${m.to}: ${reason}. Its agents run on ${m.to} from now on.${after}`);
    return moved;
  }

  private async note(id: string, body: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body });
  }

  /** A note of an agent started or resumed: it says when the window runs an older Flotilla than installed (BL-85). */
  private async startNote(id: string, body: string): Promise<void> {
    await this.note(id, `${body}${staleVersionNote()}`);
  }

  /** Stops the loop, saying why; the ticket offers the fixes for it (and "Needs you" lists it). */
  private async stopLoop(id: string, reason: string, o: { kind: ReviewStopKind; task?: RevisionTask }): Promise<void> {
    await this.setReview(id, (r) => ({
      ...(r ?? { round: 0, reviewer: '' }),
      state: 'stopped',
      reason,
      stop: { kind: o.kind, ...(o.task ? { task: o.task } : {}) },
    }));
    await this.note(id, `The review stopped: ${reason}`);
  }

  /** Pauses an agent that hit Claude's usage limit: its chat goes on by itself when the limit resets. */
  private async pause(
    id: string,
    o: { phase: 'review' | 'work'; session: string; agent: string; resume: 'working' | 'reviewing' | 'revising'; limit: UsageLimit },
  ): Promise<void> {
    const before = this.retrying.get(id);
    this.retrying.delete(id);
    // A resumed agent that hits a guessed-at limit again: one more try, a longer wait, and the note it had still holds.
    const again = before && !o.limit.known ? { tries: before.tries + 1, since: before.since } : undefined;
    const until = again ? new Date(Date.now() + retryDelay(o.limit.kind, again.tries, Date.now() - Date.parse(again.since))) : o.limit.until;
    await this.setReview(id, (r) => ({
      ...(r ?? { round: 0, reviewer: '' }),
      state: 'paused',
      paused: {
        until: until.toISOString(),
        known: o.limit.known,
        phase: o.phase,
        session: o.session,
        agent: o.agent,
        resume: o.resume,
        ...(o.limit.known ? {} : { kind: o.limit.kind, tries: again?.tries ?? 0, since: again?.since ?? new Date().toISOString() }),
      },
    }));
    if (!again) {
      const what = o.limit.kind === 'usage' ? "Claude's usage limit" : o.limit.kind === 'rate' ? "Claude's rate limit" : 'Claude being overloaded';
      const when = until.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      await this.note(
        id,
        `${o.agent} stopped on ${what}. It goes on by itself ${o.limit.known ? `when it resets (${when})` : `at ${when}, and tries again after that if it must, less often the longer it lasts`}.` +
          (o.limit.said
            ? `\n\nClaude said: “${o.limit.said}”; reset time not understood, retrying in ${Math.round((until.getTime() - Date.now()) / 60_000)} min.`
            : ''),
      );
    }
    this.scheduleResume();
  }

  /**
   * Agents resumed after a limit whose reset wasn't said, with the tries so far: hitting it again goes on backing off,
   * without another note.
   */
  private readonly retrying = new Map<string, { tries: number; since: string }>();
  /** The limits (see limitGroup) whose probe (is Claude taking work again?) is running. */
  private readonly probing = new Set<string>();

  /** Which limit a pause whose reset wasn't said waits on: one per model and kind, whichever agents hit it (BL-179). */
  private limitGroup(item: BacklogItem, p: NonNullable<ReviewState['paused']>): string {
    return `${agentChoice(item, p.phase === 'review' ? 'review' : 'work').model ?? ''}|${p.kind ?? 'usage'}`;
  }

  /**
   * Whether Claude takes work again for the agents paused on one limit whose reset wasn't said, asked once for them all
   * (for the oldest pause), outside their chats: the tries leave no prompts there and no notes in the ticket. When it
   * does, they all go on (see limitLiftedFor); when it doesn't, the next try waits longer, for every one of them.
   */
  private async probeGroup(key: string, group: Array<{ item: BacklogItem; p: NonNullable<ReviewState['paused']> }>): Promise<void> {
    if (this.probing.has(key)) return;
    this.probing.add(key);
    const { item, p } = oldestFirst(group)[0];
    const limit = await probeLimit({ choice: agentChoice(item, p.phase === 'review' ? 'review' : 'work'), output: this.deps.output }).finally(() =>
      this.probing.delete(key),
    );
    const agents = group.map((g) => `${g.p.agent} (${g.item.id})`).join(', ');
    if (!limit) return this.limitLiftedFor(group, `found while resuming ${p.agent}`, p.agent);
    if (limit.known) {
      this.deps.output.appendLine(`${agents} wait for the limit still: it resets at ${limit.until.toLocaleString()}.`);
      return this.knownReset(limit.until);
    }
    const tries = (p.tries ?? 0) + 1;
    const until = new Date(Date.now() + retryDelay(p.kind ?? limit.kind, tries, Date.now() - Date.parse(p.since ?? new Date().toISOString())));
    this.deps.output.appendLine(
      `${agents} wait for the limit still: try ${tries + 1} at ${until.toLocaleString()}.${limit.said ? ` Claude said: ${limit.said}` : ''}`,
    );
    for (const g of group)
      await this.setReview(g.item.id, (r) =>
        r?.state === 'paused' && r.paused && r.paused.session === g.p.session
          ? { ...r, paused: { ...r.paused, until: until.toISOString(), tries: (r.paused.tries ?? 0) + 1 } }
          : r!,
      );
  }

  /**
   * The limit these agents wait on lifted (a probe or another agent's run found it): they all go on, oldest pause first,
   * as queued starts at the head of the queue. `found` says how, in their tickets (not in the one it was found for).
   */
  private async limitLiftedFor(group: Array<{ item: BacklogItem; p: NonNullable<ReviewState['paused']> }>, found: string, foundFor?: string): Promise<void> {
    this.deps.limitLifted?.();
    // Read again: the probe took a while, and one may have gone on (Resume now) or been stopped meanwhile.
    const items = (await this.deps.backlog.read()).items;
    for (const { item, p } of oldestFirst(group)) {
      const fresh = items.find((i) => i.id === item.id);
      if (!fresh || this.runs.has(item.id) || this.waiting.has(item.id)) continue;
      if (fresh.review?.state !== 'paused' || fresh.review.paused?.session !== p.session || fresh.review.paused.byUser) continue;
      await this.resumeOne(fresh, {}, p.agent === foundFor ? undefined : found);
    }
  }

  /**
   * An agent's run ended without a limit: Claude takes work for its model again, so the agents paused on a guessed-at
   * limit for that model go on now rather than at their next try (BL-179). The leading window only, as resumePaused.
   */
  private async liftedByRun(id: string, phase: 'review' | 'work'): Promise<void> {
    if (this.deps.isLeader && !this.deps.isLeader()) return;
    try {
      const d = await this.deps.backlog.read();
      const item = d.items.find((i) => i.id === id);
      if (!item) return;
      const model = agentChoice(item, phase).model ?? '';
      const group = d.items.flatMap((i) => {
        const p = i.review?.state === 'paused' ? i.review.paused : undefined;
        if (!p || p.byUser || p.for || p.known !== false || this.runs.has(i.id) || this.waiting.has(i.id)) return [];
        return (agentChoice(i, p.phase === 'review' ? 'review' : 'work').model ?? '') === model ? [{ item: i, p }] : [];
      });
      if (!group.length) return;
      const agent = (phase === 'review' ? item.review?.reviewer : item.review?.implementer) || id;
      this.deps.output.appendLine(`${agent}'s run (${id}) got through: the limit lifted for ${group.map((g) => g.p.agent).join(', ')}.`);
      await this.limitLiftedFor(group, `found by ${agent}'s run`);
      this.scheduleResume();
    } catch (e: unknown) {
      this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Claude said when its usage limit resets: every agent paused on a limit whose reset was guessed at waits for that one
   * (it's the same limit, the account's), and they all go on when it resets.
   */
  private async knownReset(until: Date): Promise<void> {
    for (const item of (await this.deps.backlog.read()).items) {
      const p = item.review?.state === 'paused' ? item.review.paused : undefined;
      if (!p || p.byUser || p.for || p.known !== false) continue;
      await this.setReview(item.id, (r) =>
        r?.state === 'paused' && r.paused && r.paused.known === false
          ? { ...r, paused: { ...r.paused, until: until.toISOString(), known: true, kind: 'usage' } }
          : r!,
      );
    }
    this.scheduleResume();
  }

  /** The next resume, timed to the earliest paused agent. */
  private scheduleResume(): void {
    void this.deps.backlog.read().then((d) => {
      // Past times are left to the minute's retry: a resume that waits for a slot would be tried every second otherwise.
      const next = d.items
        .flatMap((i) => (i.review?.state === 'paused' && i.review.paused?.until ? [Date.parse(i.review.paused.until)] : []))
        .filter((t) => t > Date.now())
        .sort((a, b) => a - b)[0];
      clearTimeout(this.resumeTimer);
      if (next === undefined) return;
      this.resumeTimer = setTimeout(() => void this.resumePaused(), Math.min(Math.max(1000, next - Date.now()), 2 ** 31 - 1));
    });
  }

  /**
   * The earliest time agents paused on a limit go on (for the autopilot: no new work starts before). One whose time has
   * passed but hasn't gone on yet (its limit not probed yet, BL-179) holds it now. One whose resume is queued (Try Now,
   * BL-132) waits for a slot, not for the limit: the queue holds new work back for it.
   */
  async pausedUntil(): Promise<Date | undefined> {
    const d = await this.deps.backlog.read();
    const times = d.items.flatMap((i) => {
      const p = i.review?.state === 'paused' ? i.review.paused : undefined;
      return p?.until && p.known !== undefined && !p.for && !p.byUser && !this.waiting.has(i.id) && !this.runs.has(i.id) ? [Date.parse(p.until)] : [];
    });
    const next = times.sort((a, b) => a - b)[0];
    return next === undefined ? undefined : new Date(Math.max(next, Date.now()));
  }

  /**
   * Try Now (BL-132): whether Claude takes work again, asked once outside the chats (see probeGroup). When it does, the
   * agents paused on a limit go on, top of the backlog first, as queued starts (within flotilla.agents.maxRunning);
   * when it doesn't, none is started, the top one's wait follows the reset Claude says now, and `limited` says when
   * they go on by themselves. Undefined when no agent waits for a limit.
   */
  async tryPausedNow(): Promise<{ tried: Date; resumed: number; limited?: Date } | undefined> {
    const limitPaused = (i: BacklogItem) => i.review?.state === 'paused' && !!i.review.paused && !i.review.paused.byUser && !i.review.paused.for;
    const paused = (await this.deps.backlog.read()).items.filter(limitPaused);
    const first = paused[0]?.review?.paused;
    if (!first) return undefined;
    const tried = new Date();
    const limit = await probeLimit({ choice: agentChoice(paused[0], first.phase === 'review' ? 'review' : 'work'), output: this.deps.output });
    if (limit) {
      // A reset said now replaces the top one's; a guessed-at one keeps its wait (the user's try doesn't lengthen it).
      if (limit.known) {
        await this.setReview(paused[0].id, (r) =>
          r?.state === 'paused' && r.paused ? { ...r, paused: { ...r.paused, until: limit.until.toISOString() } } : r!,
        );
        await this.knownReset(limit.until);
      }
      this.scheduleResume();
      return { tried, resumed: 0, limited: await this.pausedUntil() };
    }
    this.deps.limitLifted?.();
    let resumed = 0;
    // Read again: the probe took a while, and one may have gone on (or been stopped) meanwhile.
    for (const item of (await this.deps.backlog.read()).items.filter(limitPaused)) {
      if (this.runs.has(item.id) || this.waiting.has(item.id)) continue;
      await this.resumeOne(item, {});
      resumed++;
    }
    this.scheduleResume();
    return { tried, resumed };
  }

  /**
   * Once a minute (the leading window): a ticket whose agent should be at work, but runs in no window, is stopped with
   * a way on (BL-87). That's an agent the window ended when it reloaded or closed: nothing else would move it on. Its
   * chat tells: one that isn't working and hasn't changed for LOST_AFTER_MS. An agent this window runs, one starting,
   * or one whose chat isn't known (yet) is left alone.
   */
  private async recoverLost(now = Date.now()): Promise<void> {
    if (this.deps.isLeader && !this.deps.isLeader()) return;
    const d = await this.deps.backlog.read();
    for (const item of d.items) {
      const r = item.review;
      if (!r || (r.state !== 'working' && r.state !== 'revising' && r.state !== 'reviewing')) continue;
      if (this.runs.has(item.id) || [...this.starting.values()].includes(item.id) || this.waiting.has(item.id)) continue;
      const review = r.state === 'reviewing';
      const session = review ? r.reviewerSession : r.implementerSession;
      const chat = this.chatById(session);
      if (!chat || chat.state === 'working' || chat.state === 'waiting-for-input' || isRunningHeadless(chat.id)) continue;
      if (now - chat.updatedAt.getTime() < LOST_AFTER_MS) continue;
      const agent = (review ? r.reviewer : r.implementer) || 'Its agent';
      const task: RevisionTask | undefined = review
        ? undefined
        : { prompt: 'Go on where you left off, then report in the ticket as asked.', why: `${agent} stopped without finishing`, aside: true };
      await this.stopLoop(item.id, `${agent} stopped without finishing (the window it ran in reloaded or closed).`, {
        kind: review ? 'no-verdict' : 'no-report',
        task,
      });
    }
  }

  /** Whether this window runs, starts or has queued the agent of an item's review (a Check: BL-163). */
  runsAgentOf(id: string): boolean {
    return this.runs.has(id) || [...this.starting.values()].includes(id) || this.waiting.has(id);
  }

  /**
   * A Check found the review's agent runs nowhere (lost), or a paused agent's chat gone: the loop stops as recoverLost
   * stops it, with its way on offered, and no note (the Check leaves its own). Nothing changes if it runs after all.
   */
  async stopForCheck(id: string, what: 'lost' | 'paused-gone', reason: string): Promise<boolean> {
    const r = (await this.deps.backlog.read()).items.find((i) => i.id === id)?.review;
    if (!r || this.runsAgentOf(id)) return false;
    if (what === 'paused-gone') {
      if (r.state !== 'paused') return false;
      await this.setReview(id, (now) => ({ ...now!, state: 'stopped', reason, paused: undefined, stop: { kind: 'chat-gone' } }));
      return true;
    }
    if (r.state !== 'working' && r.state !== 'revising' && r.state !== 'reviewing') return false;
    const review = r.state === 'reviewing';
    const task: RevisionTask | undefined = review
      ? undefined
      : { prompt: 'Go on where you left off, then report in the ticket as asked.', why: reason, aside: true };
    await this.setReview(id, (now) => ({ ...now!, state: 'stopped', reason, stop: { kind: review ? 'no-verdict' : 'no-report', ...(task ? { task } : {}) } }));
    return true;
  }

  /** Check's Clean Up of a review whose `worktree` is gone or on another branch (BL-167): it then works in the item's. */
  async clearWorktreeForCheck(id: string, worktree: string): Promise<boolean> {
    const r = (await this.deps.backlog.read()).items.find((i) => i.id === id)?.review;
    if (!r || r.worktree !== worktree) return false;
    await this.setReview(id, (now) => ({ ...now!, worktree: undefined }));
    return true;
  }

  /**
   * Paused agents whose limit has reset go on, as queued starts (see admitStart): the leading window only. Resume now (a
   * force) goes on at once.
   */
  async resumePaused(force?: string): Promise<void> {
    if (!force && this.deps.isLeader && !this.deps.isLeader()) return;
    const d = await this.deps.backlog.read();
    // The pauses on a limit whose reset wasn't said, by the limit they wait on: one probe asks for them all.
    const guessed = new Map<string, Array<{ item: BacklogItem; p: NonNullable<ReviewState['paused']> }>>();
    for (const item of d.items) {
      // Paused by the user, it waits for them.
      const p = item.review?.state === 'paused' && !item.review.paused?.byUser ? item.review.paused : undefined;
      if (!p || this.runs.has(item.id) || (!force && this.waiting.has(item.id))) continue;
      if (force) {
        if (force === item.id) await this.resumeOne(item, { manual: true });
        continue;
      }
      if (!p.known && !p.for) {
        const key = this.limitGroup(item, p);
        guessed.set(key, [...(guessed.get(key) ?? []), { item, p }]);
        continue;
      }
      if (!p.until || Date.parse(p.until) > Date.now()) continue;
      await this.resumeOne(item, {});
    }
    // A limit is tried when any of its agents' time has come (they all wait for the same next try, see probeGroup).
    for (const [key, group] of guessed) if (group.some(({ p }) => !!p.until && Date.parse(p.until) <= Date.now())) await this.probeGroup(key, group);
    this.scheduleResume();
  }

  /** Goes on with a paused agent's chat, once it's admitted (see admitStart). */
  private async resumeOne(item: BacklogItem, o: StartOptions, found?: string): Promise<void> {
    const p = item.review?.paused;
    if (!p) return;
    if (!validSession(p.session)) {
      await this.stopLoop(item.id, `its paused chat isn't a valid session (${p.session.slice(0, 40)}).`, { kind: 'chat-gone' });
      return;
    }
    const admitted = await this.admitStart(item, 'resume', o, (fresh) => this.resumeOne(fresh, { ...o, dispatched: true }, found));
    if (!admitted) return;
    let spawned = false;
    try {
      const cwd = this.worktreeOf(item)?.worktree.path ?? this.deps.mainRoot;
      const run = runAgentHeadless({
        cwd,
        resume: p.session,
        prompt: p.for ? resumeAfterPausePrompt(p.phase) : resumeAfterLimitPrompt(p.phase),
        name: `${p.agent} · ${p.phase === 'review' ? `review ${item.id}` : item.id}`,
        track: { ticket: item.id, agent: p.agent, role: p.phase === 'review' ? 'review' : 'work' },
        choice: agentChoice(item, p.phase === 'review' ? 'review' : 'work'),
        output: this.deps.output,
        slot: admitted.slot,
      });
      spawned = true;
      this.launched(item.id, admitted.slot, { run, phase: p.phase, agent: p.agent, cwd, since: Date.now() });
      void trackProgress('backlog', `${p.agent} goes on with ${item.id}`, () => run.done);
      await this.setReview(item.id, (r) => ({ ...r!, state: p.resume, paused: undefined }));
      if (!p.for) {
        const minutes = p.since ? Math.round((Date.now() - Date.parse(p.since)) / 600) / 100 : undefined;
        recordEvent('limit-lifted', {
          ticket: item.id,
          agent: p.agent,
          data: { ...(minutes !== undefined ? { minutes } : {}), ...(p.tries ? { tries: p.tries } : {}) },
        });
      }
      // "chat for agent <name>": the ticket links the note to the chat.
      if (!p.known && !p.for) this.retrying.set(item.id, { tries: p.tries ?? 0, since: p.since ?? new Date().toISOString() });
      const since = p.since ? new Date(p.since).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      await this.startNote(
        item.id,
        p.for
          ? `A slot freed: resumed the chat for agent ${p.agent} to go on.`
          : found
            ? `The limit lifted (${found}): resumed the chat for agent ${p.agent} to go on.`
            : p.tries
              ? `The limit reset after ${p.tries + 1} tries (since ${since}): resumed the chat for agent ${p.agent} to go on.`
              : `The limit reset: resumed the chat for agent ${p.agent} to go on.`,
      );
      void run.done.then((result) => (p.phase === 'review' ? this.afterReview(item.id, run, result) : this.afterRevision(item.id, run, result)));
    } finally {
      if (!spawned) this.release(admitted.slot);
    }
  }

  /**
   * The agents running now: this window's, the starts it admitted that haven't spawned yet (see take), and the agent
   * chats (for tickets) that work in any window, each session once. The limit counts them all: a start from a ticket
   * (its chat in Claude Code) takes its slot too; a discussion's chat doesn't (BL-188: the user is in it). The same
   * agents as agentsNow lists, less those it marks not counted.
   */
  get running(): number {
    return this.agentsNow().filter((a) => !a.uncounted).length;
  }

  /**
   * The agents counted in running, each once, for the autopilot's details: this window's runs, the starts admitted, the
   * agent chats. A session that works here (isWorkingHere, what a ticket's Check calls working) counts whatever its
   * chat's record, a pause or an end says, and says when it's held (BL-201); a chat that says it's working but that
   * the loop has as held or ended, with nothing running it here, is listed as not counted, with why.
   */
  agentsNow(): AutopilotAgent[] {
    const agents: AutopilotAgent[] = [];
    const sessions = new Set<string>();
    const held = (session: string) => (this.held.has(session) ? { held: this.held.get(session) } : {});
    for (const [id, r] of this.runs) {
      sessions.add(r.run.sessionId);
      agents.push({ id, agent: r.agent, doing: r.phase, since: new Date(r.since).toISOString(), ...held(r.run.sessionId) });
    }
    for (const ws of this.deps.repository.current)
      for (const chat of ws.chats) {
        const of = agentChatItem(chat.firstPrompt);
        if (!of || !countsAsAgent(chat.firstPrompt) || sessions.has(chat.id)) continue;
        const here = isWorkingHere(chat.id);
        if (!here && chat.state !== 'working') continue;
        sessions.add(chat.id);
        const line = { id: of.item, agent: of.agent, doing: 'work' as const, since: (chat.startedAt ?? chat.updatedAt)?.toISOString() };
        const uncounted = here
          ? undefined
          : this.held.has(chat.id)
            ? `${this.held.get(chat.id)} by you`
            : this.ended.has(chat.id)
              ? 'its run here ended'
              : undefined;
        agents.push({ ...line, ...held(chat.id), ...(uncounted ? { uncounted: `${uncounted}, though its chat says it's working` } : {}) });
      }
    for (const id of this.starting.values()) agents.push({ id, doing: 'starting' });
    return agents;
  }

  /** The starts waiting, in the order they start in (for the autopilot's details). */
  queuedStarts(): AutopilotQueued[] {
    return this.waiting.ordered().map((w) => ({ id: w.id, reason: w.reason, kind: w.kind, ...(w.at ? { since: new Date(w.at).toISOString() } : {}) }));
  }

  /**
   * The sessions of runs this window ended: a stopped process doesn't record "done" in its chat (until the record goes
   * stale), so its chat still says "working". A session that runs again here (a run launched, or a reply to a comment)
   * isn't ended while it runs: see isEnded. Known gap: a chat
   * this window ended, which the user then resumes in Claude Code (not through Flotilla), isn't counted while it works,
   * until its record goes stale.
   */
  private readonly ended = new Set<string>();

  /** Whether this window ended a chat's run (its chat may still say it's working). */
  hasEnded(session: string): boolean {
    return this.isEnded(session);
  }

  /** Ended, and not running again without a window now (a reply to a comment resumes it outside the loop's runs). */
  private isEnded(session: string): boolean {
    return this.ended.has(session) && !isRunningHeadless(session);
  }

  /**
   * The sessions of agents the user paused or stopped, in any window (as of the last scan): they take no slot, unless
   * they still work here (see agentsNow).
   */
  private held = new Map<string, 'paused' | 'stopped'>();

  /**
   * Starts an agent on an item's work, without a window (for the autopilot, and Start an Agent by hand: BL-122): it
   * reports in the ticket, asks there when it must ("Waiting for you."), and its "Ready for review." goes on to review.
   * `slot` is the start the autopilot was admitted with (see admitNew); without one, the start is admitted here, and may
   * wait in the queue (a start by hand too: it counts toward the limit like any agent).
   */
  async startWork(item: BacklogItem, ws: Workstream, o: { slot?: number; dispatched?: boolean; byHand?: boolean } = {}): Promise<void> {
    const { slot, dispatched = false, byHand = false } = o;
    if (!ws.worktree.path || !ws.worktree.branch || this.runs.has(item.id)) {
      if (slot !== undefined) this.release(slot);
      return;
    }
    const admitted =
      slot !== undefined
        ? { slot, since: stateOf(item) }
        : await this.admitStart(item, 'new', { dispatched }, (fresh) => this.startWork(fresh, ws, { dispatched: true, byHand }));
    if (!admitted) return;
    let spawned = false;
    try {
      const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
      const agent = agentName(taken);
      const ticket = await this.deps.backlog.ensureDocument(item);
      // Checked where the agent starts: the awaits above may have let another start for the item in, or changed the item.
      if (this.runs.has(item.id)) return;
      if (!(await this.unchanged(item.id, admitted.since))) {
        await this.note(item.id, 'The start is given up: the ticket changed while it was starting.');
        return;
      }
      const guide = path.join(this.deps.backlog.dir, GUIDE);
      const choice = agentChoice(item);
      const note = byHand ? HAND_START_NOTE : AUTOPILOT_NOTE;
      const task: RevisionTask = { prompt: note, why: byHand ? 'you started it' : 'the autopilot started it' };
      const run = runAgentHeadless({
        cwd: ws.worktree.path,
        prompt: [
          agentLead(item, agent),
          agentPrompt(
            item,
            ticket,
            ws.worktree.branch,
            agent,
            guide,
            await mapFor(this.deps.backlog, this.deps.mainRoot, item),
            (await this.deps.backlog.read()).items,
          ),
          note,
        ].join('\n\n'),
        name: `${agent} · ${item.id}`,
        track: { ticket: item.id, agent, role: 'work' },
        choice,
        output: this.deps.output,
        slot: admitted.slot,
      });
      spawned = true;
      this.launched(item.id, admitted.slot, { run, phase: 'work', agent, cwd: ws.worktree.path, since: Date.now() });
      this.tasks.set(item.id, task);
      void trackProgress('backlog', `${agent} is working on ${item.id}${byHand ? '' : ' (autopilot)'}`, () => run.done);
      await this.setReview(item.id, (r) => ({
        ...(r ?? { round: 0, reviewer: '' }),
        state: 'working',
        autopilot: !byHand,
        byHand: byHand || undefined,
        implementer: agent,
        implementerSession: run.sessionId,
        worktree: ws.key,
        reason: undefined,
        stop: undefined,
      }));
      await this.startNote(
        item.id,
        `${byHand ? 'Opened' : 'Autopilot: opened'} a chat for agent ${agent}${describeChoice(choice)} in worktree \`${workstreamLabel(ws)}\`. It works without a window and reports here.`,
      );
      void run.done.then((result) => this.afterRevision(item.id, run, result));
    } finally {
      if (!spawned) this.release(admitted.slot);
    }
  }

  /**
   * Prioritize: starts a queued start now, above the limit while fewer than flotilla.agents.maxPrioritized agents run
   * above it. At that ceiling, the running agent the user picks is paused to make room (it goes to the head of the
   * queue). Nothing starts while memory is short. The pick is asked outside the queue, so scans and runs go on.
   */
  async prioritize(id: string): Promise<void> {
    const w = this.waiting.get(id);
    if (!w) return;
    const short = memoryShortage();
    const action = prioritizeAction({ running: this.running, limit: this.limit, maxExtra: this.maxPrioritized, memoryShort: !!short });
    if (action === 'memory' && short) {
      await this.note(
        id,
        `Not started: ${formatMemory(short.freeMB)} of memory is free, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)} before an agent starts. It starts when there's room.`,
      );
      return;
    }
    const victim = action === 'pause' ? await this.pickPause(id) : undefined;
    if (action === 'pause' && !victim) return;
    const done = this.queue
      .then(() => this.prioritizeNow(id, victim))
      .catch((e: unknown) => this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`));
    this.queue = done;
    await done;
  }

  /**
   * Runs a queued start as prioritized (see prioritize), in the queue. The pick was asked before, so the rule is decided
   * again here, with the ticket and the counts as they are now: nothing is paused for a start that won't run.
   */
  private async prioritizeNow(id: string, victim: string | undefined): Promise<void> {
    const w = this.waiting.get(id);
    if (!w) return;
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    // The item moved on while the pick was open: the start is dropped (runWaiting says so), and nothing is paused.
    if (!item || item.proposed || this.runs.has(id) || stateOf(item) !== w.since) {
      await this.runWaiting(w);
      return;
    }
    const short = memoryShortage();
    const action = prioritizeAction({ running: this.running, limit: this.limit, maxExtra: this.maxPrioritized, memoryShort: !!short });
    if (action === 'memory' && short) {
      await this.note(
        id,
        `Not started: ${formatMemory(short.freeMB)} of memory is free, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)} before an agent starts. It starts when there's room.`,
      );
      return;
    }
    let paused: { agent: string } | undefined;
    if (action === 'pause') {
      // The picked agent may have finished while the pick was open: then there's nothing to pause, and the user picks again.
      if (!victim || !this.runs.has(victim)) {
        await this.note(id, 'Not started: the agent picked to make room has finished. Prioritize again to pick another.');
        return;
      }
      paused = await this.pauseFor(victim, id);
    }
    this.priority = id;
    try {
      await this.note(
        id,
        paused ? `You prioritized it: ${paused.agent} (${victim}) was paused to make room.` : 'You prioritized it: an agent takes it up now.',
      );
      await this.runWaiting(w);
    } finally {
      this.priority = undefined;
    }
    this.fireQueue(id);
  }

  /**
   * Asks which running agent to pause for a prioritized start: the cheapest to interrupt first (reviewers, agents that
   * just started, those not running a build or tests). Undefined if the user picks none.
   */
  private async pickPause(forId: string): Promise<string | undefined> {
    const runs = await Promise.all([...this.runs].map(async ([id, live]) => ({ id, live, busy: await this.busy(live) })));
    if (!runs.length) {
      void vscode.window.showInformationMessage(`No agent Flotilla runs here can be paused for ${forId}: the running ones are in chats.`);
      return undefined;
    }
    const ranked = pauseOrder(runs.map((r) => ({ ...r, reviewer: r.live.phase === 'review', ranForMs: Date.now() - r.live.since })));
    const pick = await vscode.window.showQuickPick(
      ranked.map((r) => ({
        label: `${r.live.agent}: ${r.live.phase === 'review' ? `reviewing ${r.id}` : `working on ${r.id}`}`,
        description: `running for ${minutes(r.ranForMs)}`,
        detail: r.busy ? 'Running a build or tests now: interrupting it loses that run.' : 'Not running a build or tests.',
        id: r.id,
      })),
      {
        title: `Pause an agent for ${forId}`,
        placeHolder: 'The cheapest to interrupt is first. It goes back to the head of the queue and resumes from its chat when a slot frees.',
      },
    );
    return pick?.id;
  }

  /** Whether a run is running a build or tests now (from its transcript; false if it can't be read). */
  private async busy(live: Running): Promise<boolean> {
    try {
      return await transcriptBusy(transcriptPath(live.cwd, live.run.sessionId));
    } catch {
      return false;
    }
  }

  /**
   * Stops a running agent to make room for a prioritized start: its chat is kept, its worktree too. It goes back to the
   * head of the queue as a resume, and its ticket says what it was paused for. Undefined if it isn't running any more.
   */
  private async pauseFor(victim: string, forId: string): Promise<{ agent: string } | undefined> {
    const live = this.runs.get(victim);
    if (!live) return undefined;
    this.runs.delete(victim);
    this.noteAgents();
    this.ended.add(live.run.sessionId);
    live.run.stop();
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === victim);
    if (!item?.review) return undefined;
    const state = item.review.state;
    const resume = state === 'working' || state === 'revising' || state === 'reviewing' ? state : live.phase === 'review' ? 'reviewing' : 'revising';
    const review: ReviewState = {
      ...item.review,
      state: 'paused',
      paused: { until: new Date().toISOString(), known: true, phase: live.phase, session: live.run.sessionId, agent: live.agent, resume, for: forId },
    };
    await this.setReview(victim, () => review);
    recordEvent('agent-paused', {
      ticket: victim,
      agent: live.agent,
      data: { role: live.phase === 'review' ? 'review' : 'work', session: live.run.sessionId, reason: 'slot' },
    });
    this.waiting.add({
      id: victim,
      kind: 'resume',
      manual: false,
      reason: 'slot',
      since: stateOf({ ...item, review }),
      at: Date.now(),
      front: true,
      start: (fresh) => this.resumeOne(fresh, { dispatched: true }),
    });
    this.fireQueue(victim);
    await this.note(
      victim,
      `${live.agent} is paused for ${forId}: its slot went to a prioritized start. It goes back to the head of the queue and resumes from its chat when a slot frees. Its uncommitted changes stay in its worktree.`,
    );
    return { agent: live.agent };
  }

  /** Fixes a stopped review (a button on the ticket or the notification). */
  async fix(id: string, fix: ReviewFix): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const r = item?.review;
    if (!item || !r || this.runs.has(id)) return;
    if (fix === 'resumeNow') return this.resumePaused(id);
    if (fix === 'resume') return this.control(id, 'resume');
    // A reviewer the user stopped: Review Again starts a review, not changes.
    if (fix === 'retry' && r.stop?.kind === 'user' && r.stop.agent?.phase === 'review') return this.start(id, true);
    const task: RevisionTask | undefined =
      r.stop?.task ??
      (r.reviewer && r.stop?.kind !== 'no-verdict' && r.stop?.kind !== 'no-worktree'
        ? {
            prompt: revisionPrompt({ item, reviewer: r.reviewer, ticket: this.deps.backlog.docPath(id), round: r.round }),
            why: `${r.reviewer} requested changes`,
          }
        : undefined);
    const revising = async (extra = 0): Promise<BacklogItem> => {
      const review: ReviewState = { ...r, state: 'revising', reason: undefined, stop: undefined, extraRounds: (r.extraRounds ?? 0) + extra };
      this.statuses.set(id, 'doing');
      await this.setReview(id, () => review, 'doing', 'You');
      return { ...item, status: 'doing', review };
    };
    switch (fix) {
      case 'worktree':
        await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: false });
        if (!this.worktreeOf(item)) return;
        return task ? this.startRevision(await revising(), task, { manual: true }) : this.start(id, true);
      case 'anotherRound':
        if (task && r.stop?.kind === 'rounds' && r.state === 'stopped' && r.stop.task) return this.startRevision(await revising(1), task, { manual: true });
        await this.setReview(id, (x) => ({ ...x!, extraRounds: (x!.extraRounds ?? 0) + 1, stop: undefined }));
        return this.startRound({ ...item, review: { ...r, extraRounds: (r.extraRounds ?? 0) + 1 } }, true);
      case 'retry':
        return task ? this.startRevision(await revising(), task, { manual: true }) : this.start(id, true);
      case 'newAgent':
        if (!task) return this.start(id, true);
        return this.startRevision(await revising(), { ...task, resumeOnly: false }, { fresh: true, manual: true });
      case 'inChat': {
        const chat = this.chatOf(r.implementer) ?? this.chatById(r.implementerSession);
        if (!chat || !task) return;
        // The implementer takes it in its own chat: its "Ready for review." goes on with the loop.
        await revising();
        await vscode.env.clipboard.writeText(task.prompt);
        await vscode.commands.executeCommand('flotilla.openChat', { key: chat.ws.key, chatId: chat.id, prompt: task.prompt });
        await this.note(id, `You gave ${r.implementer} the request in its chat.`);
        void vscode.window.showInformationMessage(`The request for ${r.implementer} is in its chat's message box (and on the clipboard): send it there.`);
        return;
      }
    }
  }

  /** The implementer's task of each item now being revised (for going on, when it stops early). */
  private readonly tasks = new Map<string, RevisionTask>();

  /** A chat in the repository, by its session. */
  private chatById(session: string | undefined): { ws: Workstream; id: string; cwd?: string; state: string; updatedAt: Date } | undefined {
    if (!session) return undefined;
    for (const ws of this.deps.repository.current) {
      const chat = ws.chats.find((c) => c.id === session);
      if (chat) return { ws, id: chat.id, cwd: chat.cwd, state: chat.state, updatedAt: chat.updatedAt };
    }
    return undefined;
  }

  /** The agents' chats in the repository, by agent name. */
  private chatOf(agent: string | undefined): { ws: Workstream; id: string; cwd?: string; state: string } | undefined {
    for (const ws of this.deps.repository.current) {
      const chat = ws.chats.find((c) => sameAgent(agentChatItem(c.firstPrompt)?.agent, agent));
      if (chat) return { ws, id: chat.id, cwd: chat.cwd, state: chat.state };
    }
    return undefined;
  }

  /** The worktree the work is in: the review's, the implementer's chat's, or the item's first. */
  private worktreeOf(item: BacklogItem): Workstream | undefined {
    const all = this.deps.repository.current.filter(
      (w) => !w.worktree.isMain && w.worktree.path && w.worktree.branch && branchMatches(item, w.worktree.branch),
    );
    return all.find((w) => w.key === item.review?.worktree) ?? all.find((w) => w.key === this.chatOf(item.review?.implementer)?.ws.key) ?? all[0];
  }

  /** Starts a review round now (Start Review, or a move into review: automatic, unless manual). */
  async start(id: string, manual = false): Promise<void> {
    let item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item || this.runs.has(id)) return;
    if (item.status !== 'review') {
      this.statuses.set(id, 'review');
      await this.deps.backlog.change((d) => updateItem(d, id, { status: 'review' }), { by: 'Flotilla' });
      // The item as stored now (in review), so a start that waits for memory records what retry will read.
      item = (await this.deps.backlog.read()).items.find((i) => i.id === id) ?? item;
    }
    // A loop that stopped or ended starts over in its rounds count.
    await this.startRound(item, manual, item.review !== undefined && item.review.state !== 'revising');
  }

  /**
   * Pauses, stops or resumes the agent working on an item (session: that chat's; else the one working on it): one the
   * loop runs without a window, or one in a terminal. One in Claude Code's panel can't be: the user is told so, and
   * can open its chat.
   */
  async control(id: string, action: 'pause' | 'stop' | 'resume', session?: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    const paused = item.review?.state === 'paused' ? item.review.paused : undefined;
    if (action === 'resume') {
      // Paused on a limit or for another ticket: it goes on now.
      if (paused && !paused.byUser) return this.resumePaused(id);
      const held = heldBy(item.review);
      if (held && !this.runs.has(id) && (!session || held.session === session)) await this.resumeHeld(item, held);
      // Its agent stopped without a question, to go on later (BL-198): it goes on in its chat.
      else if (item.review?.state === 'asking' && !this.runs.has(id)) await this.resumeAsking(item);
      return;
    }
    // Paused by the user: stopped as it is (see stop).
    if (action === 'stop' && paused?.byUser && (!session || paused.session === session)) return this.stop(id);
    const target = this.target(item, session, (await this.deps.backlog.readTicket(item)).activity);
    if (!target) {
      // Nothing runs, but the loop waits (for an answer, or in the queue): Stop ends that.
      if (action === 'stop' && !session && item.review) await this.stop(id);
      return;
    }
    if (target.where === 'panel') {
      const chat = this.chatById(target.session);
      const choice = await vscode.window.showInformationMessage(
        `${target.agent} works in Claude Code's panel, which can't be paused or stopped from outside: stop it in its chat (Esc, or its stop button).`,
        ...(chat ? ['Open Chat'] : []),
      );
      if (choice && chat) await vscode.commands.executeCommand('flotilla.openChat', { key: chat.ws.key, chatId: chat.id });
      return;
    }
    await this.halt(item, target, action);
  }

  /**
   * Pause All's pause of an item's agent (BL-160): as Pause (see control), without asking. One in Claude Code's panel
   * can't be: it's returned, for the list of those. Undefined: no agent works on it (one paused already, by the user or
   * on a usage limit, stays as it is).
   */
  async pauseForAll(id: string): Promise<{ paused: string } | { panel: { agent: string; key?: string; chatId: string } } | undefined> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    // Paused already: by the user (it stays so), or on a limit (it isn't working; the hold keeps it from going on).
    if (!item || item.review?.state === 'paused' || heldBy(item.review)) return undefined;
    const target = this.target(item, undefined, (await this.deps.backlog.readTicket(item)).activity);
    if (!target) return undefined;
    if (target.where === 'panel') {
      const chat = this.chatById(target.session);
      return { panel: { agent: target.agent, chatId: target.session, ...(chat ? { key: chat.ws.key } : {}) } };
    }
    await this.halt(item, target, 'pause');
    return { paused: target.session };
  }

  /**
   * Resume All's resume of an agent Pause All paused (BL-160): while the item is still paused in that chat, it goes on
   * as Resume does, but within the limit: without a slot free, it waits in the queue. Undefined: it isn't paused there
   * any more (the user resumed or stopped it meanwhile).
   */
  async resumeForAll(id: string, session: string | undefined): Promise<'running' | 'waiting' | undefined> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const held = item?.review?.state === 'paused' ? heldBy(item.review) : undefined;
    if (!item || !held || this.runs.has(id) || (session && held.session !== session)) return undefined;
    await this.resumeHeld(item, held, { all: true });
    return this.waiting.has(id) ? 'waiting' : 'running';
  }

  /**
   * The agent working on an item now (or the one with that session), and where it runs: the loop's own (running, or
   * paused on a limit or for another ticket), else a busy chat started for the item by hand (in a terminal, or in
   * Claude Code's panel; the ticket's notes say which, entries).
   */
  target(item: BacklogItem, session: string | undefined, entries: TicketEntry[]): AgentTarget | undefined {
    const r = item.review;
    const own: HeldAgent | undefined =
      r?.state === 'reviewing' && r.reviewerSession
        ? { phase: 'review', session: r.reviewerSession, agent: r.reviewer, resume: 'reviewing' }
        : (r?.state === 'working' || r?.state === 'revising') && r.implementerSession
          ? { phase: 'work', session: r.implementerSession, agent: r.implementer ?? 'The agent', resume: r.state }
          : r?.state === 'paused' && r.paused && !r.paused.byUser
            ? {
                phase: r.paused.phase,
                session: r.paused.session,
                agent: r.paused.agent,
                resume: r.paused.resume,
                ...(r.paused.where ? { where: r.paused.where } : {}),
              }
            : undefined;
    if (own && (!session || own.session === session)) return { ...own, where: isRunningInTerminal(own.session) ? 'terminal' : (own.where ?? 'headless') };
    const busy = (c: { id: string; state: string }) =>
      isRunningInTerminal(c.id) || ((c.state === 'working' || c.state === 'waiting-for-input') && !this.isEnded(c.id));
    const chats = this.deps.repository.current.flatMap((w) => w.chats);
    const chat = session ? chats.find((c) => c.id === session) : chats.find((c) => c.open && busy(c) && agentChatItem(c.firstPrompt)?.item === item.id);
    if (!chat || !busy(chat)) return undefined;
    const agent = agentChatItem(chat.firstPrompt)?.agent ?? chat.agent ?? 'The agent';
    const where = isRunningInTerminal(chat.id) || startedInTerminal(entries, agent) ? 'terminal' : isRunningHeadless(chat.id) ? 'headless' : 'panel';
    return { phase: 'work', session: chat.id, agent, resume: 'working', before: r?.state ?? 'none', where };
  }

  /** Ends an item's agent if it runs in this window (without a window, or in a terminal): its slot frees. */
  private async end(id: string, session: string): Promise<void> {
    const live = this.runs.get(id);
    this.ended.add(session);
    if (live?.run.sessionId === session) {
      this.runs.delete(id);
      this.noteAgents();
      live.run.stop();
    }
    await stopTerminalAgent(session);
    this.scheduleDispatch();
  }

  /**
   * Whether the agent the user paused or stopped (at `at`, 0 when not known) still runs here: a run of its session that
   * started before then, or its terminal. One started since (a Resume here, while a scan went on with the backlog it
   * read from before: BL-201) isn't that agent, and goes on.
   */
  private heldRunsHere(id: string, session: string, at: number): boolean {
    if (at && (this.resumedAt.get(session) ?? 0) >= at) return false;
    const live = this.runs.get(id);
    if (live?.run.sessionId === session) return !at || live.since <= at;
    return isRunningInTerminal(session);
  }

  /** When this window resumed a held session (see heldRunsHere). */
  private readonly resumedAt = new Map<string, number>();

  /** Pauses or stops an agent: it ends now (here, or in the window running it), its chat kept to go on in. */
  private async halt(item: BacklogItem, target: AgentTarget, action: 'pause' | 'stop'): Promise<void> {
    const at = new Date().toISOString();
    const { where, ...rest } = target;
    const held: HeldAgent = { ...rest, ...(where === 'terminal' ? { where } : {}) };
    this.waiting.remove(item.id);
    this.fireQueue(item.id);
    // The review's state says so first: the window running it ends it when it sees that (this one, at once).
    if (action === 'pause') {
      await this.setReview(item.id, (r) => ({
        ...(r ?? { round: 0, reviewer: '' }),
        state: 'paused',
        paused: { ...held, byUser: at },
        reason: undefined,
        stop: undefined,
      }));
      recordEvent('agent-paused', {
        ticket: item.id,
        agent: held.agent,
        data: { role: held.phase === 'review' ? 'review' : 'work', session: held.session, reason: 'user' },
      });
    } else {
      const task: RevisionTask | undefined =
        held.phase === 'work'
          ? { prompt: takeOverPrompt({ stopped: held.agent, ticket: this.deps.backlog.docPath(item.id) }), why: `you stopped ${held.agent}` }
          : undefined;
      await this.setReview(item.id, (r) => ({
        ...(r ?? { round: 0, reviewer: '' }),
        state: 'stopped',
        paused: undefined,
        reason: `you stopped ${held.agent}.`,
        stop: { kind: 'user', agent: held, at, ...(task ? { task } : {}) },
      }));
    }
    await this.end(item.id, held.session);
    const how = where === 'terminal' ? ' (its terminal says its process ended)' : '';
    await this.note(
      item.id,
      action === 'pause'
        ? `You paused ${held.agent}${how}. Its chat is kept, and its work stays in the worktree as it was, changes it hadn't committed too. Resume goes on in the same chat.`
        : `You stopped ${held.agent}${how}. Resume goes on in its chat; New Agent hands the work to another agent.`,
    );
  }

  /**
   * Resumes an agent the user paused or stopped, in its chat, where it ran: without a window (a start of the user's,
   * admitted at once, see admitStart), or in a new terminal.
   */
  private async resumeHeld(item: BacklogItem, held: HeldAgent, o: StartOptions = { manual: true }): Promise<void> {
    if (!validSession(held.session)) {
      await this.stopLoop(item.id, `its chat isn't a valid session (${held.session.slice(0, 40)}).`, { kind: 'chat-gone' });
      return;
    }
    const cwd = this.chatById(held.session)?.cwd ?? this.worktreeOf(item)?.worktree.path ?? this.deps.mainRoot;
    const name = `${held.agent} · ${held.phase === 'review' ? `review ${item.id}` : item.id}`;
    const choice = agentChoice(item, held.phase === 'review' ? 'review' : 'work');
    const prompt = resumeAfterUserPausePrompt(held.phase);
    // Its state first, so that no window takes it for still held and ends it again.
    const restore = async () => {
      this.ended.delete(held.session);
      this.resumedAt.set(held.session, Date.now());
      const before = held.before;
      if (before === 'none') {
        await this.deps.backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? withoutReview(i) : i)) }), { by: 'You' });
        this.changed.fire(item.id);
      } else {
        await this.setReview(item.id, (r) => ({ ...r!, state: before ?? held.resume, paused: undefined, stop: undefined, reason: undefined }));
      }
    };
    // "chat for agent <name>": the ticket links the note to the chat; ", in a terminal": where it runs.
    if (held.where === 'terminal') {
      await restore();
      runAgentInTerminal({
        cwd,
        resume: held.session,
        prompt,
        name,
        choice,
        track: { ticket: item.id, agent: held.agent, role: held.phase === 'review' ? 'review' : 'work' },
      });
      this.noteAgents();
      await this.startNote(item.id, `You resumed the chat for agent ${held.agent}, in a terminal.`);
      return;
    }
    // The user's Resume runs at once; Resume All's waits for a slot (BL-160).
    const admitted = await this.admitStart(item, 'resume', o, (fresh) => this.resumeHeld(fresh, held, { ...o, dispatched: true }));
    if (!admitted) return;
    let spawned = false;
    try {
      await restore();
      const run = runAgentHeadless({
        cwd,
        resume: held.session,
        prompt,
        name,
        choice,
        output: this.deps.output,
        slot: admitted.slot,
        track: { ticket: item.id, agent: held.agent, role: held.phase === 'review' ? 'review' : 'work' },
      });
      spawned = true;
      this.launched(item.id, admitted.slot, { run, phase: held.phase, agent: held.agent, cwd, since: Date.now() });
      void trackProgress('backlog', `${held.agent} goes on with ${item.id}`, () => run.done);
      await this.startNote(item.id, `You resumed the chat for agent ${held.agent} to go on.`);
      void run.done.then((result) => (held.phase === 'review' ? this.afterReview(item.id, run, result) : this.afterRevision(item.id, run, result)));
    } finally {
      if (!spawned) this.release(admitted.slot);
    }
  }

  /** The agents working on an item: the loop's, and any other chat busy with it (BL-210, for Discard's confirmation). */
  async agentsOn(id: string): Promise<AgentTarget[]> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return [];
    const entries = (await this.deps.backlog.readTicket(item)).activity;
    const first = this.target(item, undefined, entries);
    const found = first ? [first] : [];
    for (const chat of this.deps.repository.current.flatMap((w) => w.chats)) {
      if (found.some((t) => t.session === chat.id) || agentChatItem(chat.firstPrompt)?.item !== id) continue;
      const other = this.target(item, chat.id, entries);
      if (other) found.push(other);
    }
    return found;
  }

  /**
   * Ends all of an item's work, for a discard (BL-210): its agents stop as Stop stops them, and its loop and a queued
   * start end. One in Claude Code's panel can't be stopped from here, nor one that fails to: they're `left`, with why.
   */
  async discard(id: string): Promise<{ stopped: string[]; left: string[] }> {
    const stopped: string[] = [];
    const left: string[] = [];
    for (const target of await this.agentsOn(id)) {
      if (target.where === 'panel') {
        left.push(`${target.agent} works in Claude Code's panel, which can't be stopped from outside: stop it in its chat`);
        continue;
      }
      const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
      if (!item) break;
      try {
        await this.halt(item, target, 'stop');
        stopped.push(target.agent);
      } catch (error) {
        left.push(`${target.agent} didn't stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const looping = !!item?.review && item.review.state !== 'stopped' && item.review.state !== 'approved';
    if (looping || this.runs.has(id) || this.waiting.get(id)) {
      try {
        await this.stop(id);
      } catch (error) {
        left.push(`its review loop didn't stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { stopped, left };
  }

  /** Stops the loop: the running agent, if any (it can be resumed), and the handoffs. */
  async stop(id: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    // Paused by the user, it's stopped as it is (nothing runs), and can still be resumed.
    const paused = item?.review?.state === 'paused' && item.review.paused?.byUser ? item.review.paused : undefined;
    if (item && paused) {
      const { until: _u, known: _k, for: _f, byUser: _b, ...held } = paused;
      return this.halt(item, { ...held, where: held.where ?? 'headless' }, 'stop');
    }
    const target = item && this.target(item, undefined, (await this.deps.backlog.readTicket(item)).activity);
    if (item && target && target.where !== 'panel') return this.halt(item, target, 'stop');
    const live = this.runs.get(id);
    this.runs.delete(id);
    this.noteAgents();
    this.waiting.remove(id);
    this.fireQueue(id);
    if (live) this.ended.add(live.run.sessionId);
    live?.run.stop();
    await this.stopLoop(id, 'stopped by you.', { kind: 'user' });
    this.scheduleDispatch();
  }

  /** `restart`: a loop that stopped or ended starts over at round 1 (the stored round is left as it is). */
  private async startRound(item: BacklogItem, manual = false, restart = false, dispatched = false): Promise<void> {
    const max = Math.max(1, settings().get<number>('review.maxRounds', 3)) + (item.review?.extraRounds ?? 0);
    const round = (restart ? 0 : (item.review?.round ?? 0)) + 1;
    if (round > max) {
      await this.stopLoop(item.id, `still not approved after ${max} rounds; it's yours to decide.`, { kind: 'rounds' });
      return;
    }
    const ws = this.worktreeOf(item);
    if (!ws?.worktree.path || !ws.worktree.branch) {
      await this.stopLoop(item.id, 'it has no worktree to review.', { kind: 'no-worktree' });
      return;
    }
    const admitted = await this.admitStart(item, 'review', { manual, dispatched }, (fresh) => this.startRound(fresh, manual, restart, true));
    if (!admitted) return;
    let spawned = false;
    try {
      const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
      const reviewer = item.review?.reviewer || agentName([...taken, item.review?.implementer ?? '']);
      const base = (await resolveBase(this.deps.mainRoot, readSettings().defaultBase)) ?? 'HEAD';
      const ticket = await this.deps.backlog.ensureDocument(item);
      const items = (await this.deps.backlog.read()).items;
      const prompt = reviewerPrompt({ item, reviewer, implementer: item.review?.implementer, ticket, branch: ws.worktree.branch, base, round, items });
      // Checked where the agent starts: the awaits above may have let another start for the item in, or changed the item.
      if (this.runs.has(item.id)) return;
      if (!(await this.unchanged(item.id, admitted.since))) {
        await this.note(item.id, 'The start is given up: the ticket changed while it was starting.');
        return;
      }
      const run = runAgentHeadless({
        cwd: ws.worktree.path,
        prompt: round === 1 || !validSession(item.review?.reviewerSession) ? prompt : prompt.split('\n\n').slice(1).join('\n\n'),
        resume: round > 1 ? validSession(item.review?.reviewerSession) : undefined,
        name: `${reviewer} · review ${item.id}`,
        track: { ticket: item.id, agent: reviewer, role: 'review' },
        choice: agentChoice(item, 'review'),
        output: this.deps.output,
        slot: admitted.slot,
      });
      spawned = true;
      this.launched(item.id, admitted.slot, { run, phase: 'review', agent: reviewer, cwd: ws.worktree.path, since: Date.now() });
      void trackProgress('backlog', `${reviewer} is reviewing ${item.id}`, () => run.done);
      await this.setReview(item.id, (r) => ({
        ...(r ?? { reviewer }),
        round,
        state: 'reviewing',
        reviewer,
        reviewerSession: run.sessionId,
        worktree: ws.key,
        reason: undefined,
        stop: undefined,
        byUser: undefined,
      }));
      await this.startNote(
        item.id,
        `Review round ${round}: ${round > 1 && item.review?.reviewerSession ? 'resumed' : 'opened'} a chat for agent ${reviewer}${describeChoice(agentChoice(item, 'review'))} in worktree \`${workstreamLabel(ws)}\`. It reviews ${item.review?.implementer ?? 'the work'} and gives a verdict here.`,
      );
      void run.done.then((result) => this.afterReview(item.id, run, result));
    } finally {
      if (!spawned) this.release(admitted.slot);
    }
  }

  private async afterReview(id: string, run: AgentRun, result: AgentResult): Promise<void> {
    if (this.runs.get(id)?.run !== run) return; // stopped
    this.runs.delete(id);
    this.noteAgents();
    if (!result.limit) this.retrying.delete(id);
    this.ended.add(run.sessionId);
    if (!result.limit && !result.error) await this.liftedByRun(id, 'review');
    this.scheduleDispatch();
    const error = result.error;
    if (result.limit) {
      const reviewer = (await this.deps.backlog.read()).items.find((i) => i.id === id)?.review?.reviewer ?? 'The reviewer';
      await this.pause(id, { phase: 'review', session: run.sessionId, agent: reviewer, resume: 'reviewing', limit: result.limit });
      return;
    }
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item?.review) return;
    const ticket = await this.deps.backlog.readTicket(item);
    const verdict = verdictReport(ticket.activity, item.review, this.key(id));
    if (!verdict) {
      await this.stopLoop(id, `${item.review.reviewer} finished without a verdict${error ? ` (${error.slice(0, 200)})` : ''}.`, { kind: 'no-verdict' });
      return;
    }
    const handled = [...(item.review.handled ?? []), this.key(id)(verdict.entry)];
    recordEvent('review-verdict', {
      ticket: id,
      agent: item.review.reviewer,
      data: { verdict: verdict.verdict, round: item.review.round, by: item.review.reviewer },
    });
    if (verdict.verdict === 'approved') {
      await this.setReview(id, (r) => ({ ...r!, state: 'approved', handled }));
      this.deps.onApproved?.(id, item.review.reviewer);
      return;
    }
    // Changes requested again: a ticket on a lighter model moves up to the strong one (BL-69).
    const strong =
      item.review.round > ROUNDS_BEFORE_MOVING_UP
        ? await this.moveUp(id, `${item.review.reviewer} requested changes in review round ${item.review.round}`)
        : undefined;
    const task: RevisionTask = {
      prompt: revisionPrompt({ item, reviewer: item.review.reviewer, ticket: this.deps.backlog.docPath(id), round: item.review.round }),
      why: `${item.review.reviewer} requested changes`,
    };
    const max = Math.max(1, settings().get<number>('review.maxRounds', 3)) + (item.review.extraRounds ?? 0);
    if (item.review.round >= max) {
      await this.setReview(id, (r) => ({ ...r!, handled }));
      await this.stopLoop(id, `${item.review.reviewer} still requests changes after ${max} rounds; it's yours to decide.`, { kind: 'rounds', task });
      return;
    }
    this.statuses.set(id, 'doing');
    await this.setReview(id, (r) => ({ ...r!, state: 'revising', handled }), 'doing', `Agent ${item.review.reviewer}`);
    const revising: BacklogItem = { ...(strong ?? item), status: 'doing', review: { ...item.review, state: 'revising', handled } };
    await this.startRevision(revising, task);
  }

  /**
   * The user's review: approved ends the loop; changes requested send the item back to its implementer (its chat
   * resumed, or a new agent), which may ask for more context first. Either stops an agent running for it.
   */
  async userReview(id: string, verdict: Verdict, text: string): Promise<void> {
    const live = this.runs.get(id);
    this.runs.delete(id);
    this.noteAgents();
    // What the user decides now replaces a start that waited.
    this.waiting.remove(id);
    this.fireQueue(id);
    if (live) this.ended.add(live.run.sessionId);
    live?.run.stop();
    this.scheduleDispatch();
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    const ticket = await this.deps.backlog.readTicket(item);
    const entry = { date: entryDate(new Date()), author: 'You', body: userReviewBody(verdict, text) };
    await this.deps.backlog.appendActivity(item, entry);
    const handled = [...(item.review?.handled ?? []), this.key(id)(entry)];
    recordEvent('review-verdict', { ticket: id, data: { verdict, round: item.review?.round ?? 0, by: 'You' } });
    if (verdict === 'approved') {
      await this.setReview(id, (r) => ({ ...(r ?? { round: 0, reviewer: '' }), state: 'approved', byUser: true, reason: undefined, handled }));
      this.deps.onApproved?.(id, undefined);
      return;
    }
    // The implementer: the review's, else the last agent that reported (not a reviewer).
    const reviewer = item.review?.reviewer;
    const implementer =
      item.review?.implementer ??
      ticket.activity
        .map((e) => entryAgent(e.author))
        .filter((a): a is string => !!a && !sameAgent(a, reviewer))
        .at(-1);
    const review: ReviewState = {
      ...(item.review ?? { reviewer: '' }),
      round: (item.review?.round ?? 0) + 1,
      state: 'revising',
      byUser: true,
      reason: undefined,
      ...(implementer ? { implementer } : {}),
      handled,
    };
    this.statuses.set(id, 'doing');
    await this.setReview(id, () => review, 'doing', 'You');
    const strong = review.round > ROUNDS_BEFORE_MOVING_UP ? await this.moveUp(id, `you requested changes in review round ${review.round}`) : undefined;
    await this.startRevision(
      { ...(strong ?? item), status: 'doing', review },
      { prompt: userRevisionPrompt({ item, ticket: this.deps.backlog.docPath(id), feedback: text }), why: 'you requested changes' },
      { reply: true },
    );
  }

  /**
   * Gives the ticket's agent a task outside the review rounds (merging main into its branch, BL-55): its chat resumed,
   * or a new agent if it has none. Like changes requested, its "Ready for review." sends the work to review again.
   * False when it wasn't handed: an agent is already running on the ticket, or the ticket is gone.
   */
  async handToImplementer(id: string, task: RevisionTask): Promise<boolean> {
    if (this.runs.has(id)) return false;
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return false;
    const ticket = await this.deps.backlog.readTicket(item);
    const reviewer = item.review?.reviewer;
    const implementer =
      item.review?.implementer ??
      ticket.activity
        .map((e) => entryAgent(e.author))
        .filter((a): a is string => !!a && !sameAgent(a, reviewer))
        .at(-1);
    const review: ReviewState = {
      ...(item.review ?? { reviewer: '', round: 0 }),
      state: 'revising',
      reason: undefined,
      stop: undefined,
      ...(implementer ? { implementer } : {}),
    };
    this.statuses.set(id, 'doing');
    await this.setReview(id, () => review, 'doing', 'You');
    await this.startRevision({ ...item, status: 'doing', review }, task, { manual: true });
    return true;
  }

  /** The user answered the implementer's question: it's resumed with the answer. */
  private async answer(item: BacklogItem, answer: string, keys: string[]): Promise<void> {
    const review: ReviewState = { ...item.review!, state: 'revising', handled: [...(item.review!.handled ?? []), ...keys] };
    await this.setReview(item.id, () => review);
    await this.startRevision(
      { ...item, review },
      { prompt: answerPrompt({ item, ticket: this.deps.backlog.docPath(item.id), answer }), why: 'you answered', resumeOnly: true },
      { reply: true },
    );
  }

  /**
   * Resume on a ticket whose agent stopped without a question (BL-198): its chat goes on, told which of the tickets it
   * waits for are merged, through the agent queue as an answer does.
   */
  private async resumeAsking(item: BacklogItem): Promise<void> {
    const data = await this.deps.backlog.read();
    const asks = resumeAsk(item, (await this.deps.backlog.readTicket(item)).activity);
    const after = (asks?.waits ?? []).flatMap((id) => data.items.find((i) => i.id.toUpperCase() === id) ?? []);
    const isMerged = (i: BacklogItem) => i.status === 'done' || !!i.merged;
    const prompt = resumeAskingPrompt({
      item,
      ticket: this.deps.backlog.docPath(item.id),
      merged: after.filter(isMerged).map((i) => i.id),
      waits: after.filter((i) => !isMerged(i)).map((i) => i.id),
    });
    const review: ReviewState = { ...item.review!, state: 'revising' };
    await this.setReview(item.id, () => review);
    await this.startRevision({ ...item, review }, { prompt, why: RESUMED, resumeOnly: true }, { reply: true });
  }

  /** Hands the requested changes to the implementer: its chat resumed, or a new agent if it has none. */
  private async startRevision(item: BacklogItem, task: RevisionTask, o: { fresh?: boolean } & StartOptions = {}): Promise<void> {
    const review = item.review!;
    const ws = this.worktreeOf(item);
    if (!ws?.worktree.path || !ws.worktree.branch) {
      await this.stopLoop(item.id, 'its worktree is gone.', { kind: 'no-worktree', task });
      return;
    }
    const ticket = this.deps.backlog.docPath(item.id);
    // Its chat (as the repository sees it now: it may be open and busy), unless a new agent is asked for.
    const chatNow = () => {
      const known = this.chatById(review.implementerSession) ?? this.chatOf(review.implementer);
      const session = validSession(review.implementerSession);
      return o.fresh ? undefined : (known ?? (session ? { id: session, cwd: undefined, state: 'done' } : undefined));
    };
    const isBusy = (c: ReturnType<typeof chatNow>) => !!c && (c.state === 'working' || c.state === 'waiting-for-input') && !isRunningHeadless(c.id);
    const busy = `${review.implementer} is still busy in its chat: give it the request there, or hand it to a new agent.`;
    if (isBusy(chatNow())) {
      await this.stopLoop(item.id, busy, { kind: 'busy', task });
      return;
    }
    const kind: StartKind = o.reply ? 'reply' : 'review';
    const admitted = await this.admitStart(item, kind, o, (fresh) => this.startRevision(fresh, task, { ...o, dispatched: true }));
    if (!admitted) return;
    let spawned = false;
    try {
      // The awaits since the check (a manual start waits on the user's answer) may have changed the item or its chat.
      if (!(await this.unchanged(item.id, admitted.since))) {
        await this.note(item.id, 'The start is given up: the ticket changed while it was starting.');
        return;
      }
      const chat = chatNow();
      if (isBusy(chat)) {
        await this.stopLoop(item.id, busy, { kind: 'busy', task });
        return;
      }
      // An agent for it may have started meanwhile (nothing awaits between this check and the start below).
      if (this.runs.has(item.id)) return;
      let run: AgentRun;
      let implementer = review.implementer;
      if (chat) {
        // Its chat ran in the folder it was started in: resumed there, it keeps everything it knew.
        run = runAgentHeadless({
          cwd: chat.cwd ?? ws.worktree.path,
          resume: chat.id,
          prompt: task.prompt,
          name: `${implementer} · ${item.id}`,
          track: { ticket: item.id, agent: implementer ?? 'The agent', role: 'work' },
          choice: agentChoice(item),
          output: this.deps.output,
          slot: admitted.slot,
        });
      } else if (task.resumeOnly) {
        await this.stopLoop(item.id, `${review.implementer ?? 'the agent'}'s chat is gone: hand it to a new agent.`, { kind: 'chat-gone', task });
        return;
      } else {
        const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
        implementer = agentName([...taken, review.reviewer]);
        const guide = path.join(this.deps.backlog.dir, GUIDE);
        run = runAgentHeadless({
          cwd: ws.worktree.path,
          prompt: [
            agentLead(item, implementer),
            agentPrompt(
              item,
              ticket,
              ws.worktree.branch,
              implementer,
              guide,
              await mapFor(this.deps.backlog, this.deps.mainRoot, item),
              (await this.deps.backlog.read()).items,
            ),
            task.prompt,
          ].join('\n\n'),
          name: `${implementer} · ${item.id}`,
          track: { ticket: item.id, agent: implementer ?? 'The agent', role: 'work' },
          choice: agentChoice(item),
          output: this.deps.output,
          slot: admitted.slot,
        });
      }
      spawned = true;
      this.launched(item.id, admitted.slot, { run, phase: 'work', agent: implementer ?? 'The agent', cwd: chat?.cwd ?? ws.worktree.path, since: Date.now() });
      void trackProgress('backlog', `${implementer} is working on ${item.id}: ${task.why}`, () => run.done);
      await this.setReview(item.id, (r) => ({ ...r!, implementer, implementerSession: run.sessionId, stop: undefined, reason: undefined }));
      this.tasks.set(item.id, task);
      // "chat for agent <name>": the ticket links the note to the chat by it.
      const where = `a chat for agent ${implementer}${describeChoice(agentChoice(item))} in worktree \`${workstreamLabel(ws)}\``;
      await this.startNote(
        item.id,
        task.resumeOnly
          ? task.why === RESUMED
            ? `You resumed ${implementer}; resumed ${where} to go on where it stopped.`
            : `You answered ${implementer}'s question; resumed ${where} to go on.`
          : task.aside
            ? `${task.why.charAt(0).toUpperCase()}${task.why.slice(1)}: ${chat ? 'resumed' : 'opened'} ${where} to take care of it.`
            : `Review round ${review.round}: ${task.why}; ${chat ? 'resumed' : 'opened'} ${where} to make them.`,
      );
      void run.done.then((result) => this.afterRevision(item.id, run, result));
    } finally {
      if (!spawned) this.release(admitted.slot);
    }
  }

  private async afterRevision(id: string, run: AgentRun, result: AgentResult): Promise<void> {
    if (this.runs.get(id)?.run !== run) return;
    this.runs.delete(id);
    this.noteAgents();
    if (!result.limit) this.retrying.delete(id);
    this.ended.add(run.sessionId);
    if (!result.limit && !result.error) await this.liftedByRun(id, 'work');
    this.scheduleDispatch();
    const error = result.error;
    if (result.limit) {
      const r = (await this.deps.backlog.read()).items.find((i) => i.id === id)?.review;
      await this.pause(id, {
        phase: 'work',
        session: run.sessionId,
        agent: r?.implementer ?? 'The agent',
        resume: r?.state === 'working' ? 'working' : 'revising',
        limit: result.limit,
      });
      return;
    }
    // A "Ready for review" report sends it to review (the scan sees it), and the next round starts.
    this.schedule();
    await this.queue;
    // The scan started it again meanwhile (it moved up to a stronger model): that run goes on.
    if (this.runs.has(id)) return;
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if ((item?.review?.state === 'revising' || item?.review?.state === 'working') && item.status !== 'review') {
      // It asked the user something: it waits for their answer (a comment).
      const ticket = await this.deps.backlog.readTicket(item);
      const last = ticket.activity.filter((e) => sameAgent(entryAgent(e.author), item.review!.implementer)).at(-1);
      if (last && saysWaitingForUser(last.body)) {
        await this.setReview(id, (r) => ({ ...r!, state: 'asking', handled: [...(r!.handled ?? []), this.key(id)(last)] }));
        return;
      }
      // Resumed, it's told to go on and report.
      const task = this.tasks.get(id);
      await this.stopLoop(id, `${item.review.implementer} stopped without reporting "Ready for review"${error ? ` (${error.slice(0, 200)})` : ''}.`, {
        kind: 'no-report',
        task: task && {
          ...task,
          prompt: `${task.prompt}\n\nYou stopped before reporting "Ready for review". Go on where you left off, then report in the ticket as asked.`,
        },
      });
    }
  }
}

/** An agent working on an item, and where it runs (in Claude Code's panel: it can't be stopped from outside). */
export type AgentTarget = Omit<HeldAgent, 'where'> & { where: 'headless' | 'terminal' | 'panel' };

/** An item without its review state. */
function withoutReview(item: BacklogItem): BacklogItem {
  const { review: _review, ...rest } = item;
  return rest;
}

/** Whether an agent chat counts against the agent limit: one started for a ticket, and not a discussion (BL-188). */
function countsAsAgent(firstPrompt: string | undefined): boolean {
  return !!agentChatItem(firstPrompt) && !isDiscussionChat(firstPrompt);
}
