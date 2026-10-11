import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import {
  agentChatItem,
  agentLead,
  agentName,
  branchMatches,
  entryAgent,
  sameAgent,
  updateItem,
  type BacklogItem,
  type BacklogStatus,
} from '../../features/backlog/backlog';
import { GUIDE } from '../../features/backlog/inbox';
import { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  answerPrompt,
  AUTOPILOT_NOTE,
  resumeAfterLimitPrompt,
  fixesFor,
  fixLabel,
  readyReport,
  reviewerPrompt,
  revisionPrompt,
  saysWaitingForUser,
  userAnswer,
  userReviewBody,
  userRevisionPrompt,
  verdictReport,
  type ReviewFix,
  type ReviewState,
  type ReviewStopKind,
  type RevisionTask,
  type Verdict,
} from '../../features/backlog/review';
import { entryDate, type TicketEntry } from '../../features/backlog/ticket';
import type { UsageLimit } from '../../features/backlog/limits';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { agentPrompt } from '../commands';
import { workstreamLabel } from '../format';
import { formatMemory } from '../../features/workstreams/memory';
import { readSettings } from '../settings';
import { agentChoice, confirmMemory, describeChoice, isRunningHeadless, memoryShortage, runAgentHeadless, validSession, type AgentResult, type AgentRun } from './agentRunner';
import { trackProgress } from '../progress';

export interface ReviewDeps {
  /** Whether this window acts on its own (agents going on after a usage limit): one window does. */
  isLeader?(): boolean;
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  mainRoot: string;
  output: vscode.OutputChannel;
  openTicket(id: string): void;
}

const settings = () => vscode.workspace.getConfiguration('flotilla');

/**
 * Runs the review loop (see review.ts) for local items: an item entering In Review gets a reviewer agent; its verdict
 * sends the item back to its implementer, or ends the loop. Agents run without a window (claude -p); their chats can be
 * opened from the ticket. Only moves seen while Flotilla runs start a review; Start Review starts one by hand.
 */
/** The item's state that decides whether a start still applies: its status and review (see mayStart). */
const stateOf = (item: BacklogItem) => JSON.stringify([item.status, item.review?.state, item.review?.round, item.review?.implementer ?? null]);

export class ReviewLoop implements vscode.Disposable {
  /** Each item's status when last seen: a move into review starts a round. */
  private readonly statuses = new Map<string, BacklogStatus>();
  /** Reports already there when Flotilla first saw an item: old news, not acted on. */
  private readonly baseline = new Map<string, string[]>();
  /** The agent running for an item (reviewer or implementer). */
  private readonly runs = new Map<string, AgentRun>();
  /**
   * Starts that wait for free memory, by item: `since` is the item's state when the start was decided (it must still be
   * that when the start runs), `again` runs the start with the item as it is now (see mayStart).
   */
  private readonly deferred = new Map<string, { since: string; again: (item: BacklogItem) => Promise<void> }>();
  private queue: Promise<void> = Promise.resolve();
  private readonly watcher: vscode.Disposable;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: ReviewDeps) {
    this.watcher = deps.backlog.watch(() => this.schedule());
    this.schedule();
    // Agents paused on a usage limit go on when it resets, and starts that waited for memory are tried again (each
    // minute: a sleeping computer skips timers).
    this.ticker = setInterval(() => this.scheduleRetry(), 60_000);
  }

  /** Retries run in the same queue as the scans: they read and write backlog.json too. */
  private scheduleRetry(): void {
    this.queue = this.queue.then(() => this.retry());
  }

  /** Once a minute: paused agents whose limit has reset go on, and starts that waited for memory go on when there's room. */
  private async retry(): Promise<void> {
    try {
      await this.resumePaused();
      for (const [id, waiting] of [...this.deferred]) {
        if (memoryShortage()) break;
        this.deferred.delete(id);
        const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
        // The item moved on, or an agent runs for it already: the start that waited is over.
        if (!item || item.proposed || this.runs.has(id) || stateOf(item) !== waiting.since) {
          if (item && !this.runs.has(id)) await this.note(id, 'The start that waited for memory is dropped: the ticket changed meanwhile.');
          continue;
        }
        await waiting.again(item);
      }
    } catch (e: unknown) {
      this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private readonly ticker: NodeJS.Timeout;
  private resumeTimer: NodeJS.Timeout | undefined;

  dispose(): void {
    this.watcher.dispose();
    clearInterval(this.ticker);
    clearTimeout(this.resumeTimer);
    this.runs.forEach((r) => r.stop());
    this.changed.dispose();
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
    for (const item of data.items) {
      const before = this.statuses.get(item.id);
      this.statuses.set(item.id, item.status);
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
          if (toUser) {
            void vscode.window
              .showInformationMessage(
                byUser
                  ? `${ready.agent} made the changes you asked for on ${item.id} "${item.title}". It's ready for your review.`
                  : `${ready.agent} finished ${item.id} "${item.title}". It's ready for your review.`,
                'Open',
              )
              .then((c) => c && this.deps.openTicket(item.id));
          }
          continue;
        }
      }
      if (automatic && item.status === 'review' && before !== 'review' && item.review?.state !== 'reviewing' && item.review?.state !== 'yours')
        await this.start(item.id);
    }
  }

  /**
   * Whether an agent may start now, with enough memory free (see memoryShortage). When it's short, a manual start asks
   * first (Start Anyway starts it); otherwise, or when the user doesn't, the start waits: `again` runs it once there's
   * room, with the item as it is then (retry checks it's still the same).
   */
  private async mayStart(item: BacklogItem, manual: boolean, again: (fresh: BacklogItem) => Promise<void>): Promise<boolean> {
    const short = memoryShortage();
    if (!short) {
      this.deferred.delete(item.id);
      return true;
    }
    if (manual && (await confirmMemory(`The agent for ${item.id}`))) {
      this.deferred.delete(item.id);
      return true;
    }
    if (!this.deferred.has(item.id))
      await this.note(item.id, `Waiting for memory: ${formatMemory(short.freeMB)} is free, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)} before an agent starts. It starts when there's room.`);
    this.deferred.set(item.id, { since: stateOf(item), again });
    this.changed.fire();
    return false;
  }

  /** Changes an item's review (and status: moved by `by`, noted in its ticket). */
  private async setReview(id: string, change: (r: ReviewState | undefined) => ReviewState, status?: BacklogStatus, by = 'Flotilla'): Promise<void> {
    await this.deps.backlog.change(
      (d) => ({
        ...d,
        items: d.items.map((i) => (i.id === id ? { ...i, review: change(i.review), ...(status ? { status } : {}) } : i)),
      }),
      { by },
    );
    this.changed.fire();
  }

  private async note(id: string, body: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body });
  }

  /** Stops the loop, saying why; the ticket (and the notification) offer the fixes for it. */
  private async stopLoop(id: string, reason: string, o: { kind: ReviewStopKind; task?: RevisionTask; notify?: boolean }): Promise<void> {
    await this.setReview(id, (r) => ({ ...(r ?? { round: 0, reviewer: '' }), state: 'stopped', reason, stop: { kind: o.kind, ...(o.task ? { task: o.task } : {}) } }));
    await this.note(id, `The review stopped: ${reason}`);
    if (o.notify === false) return;
    const fixes = fixesFor(o.kind, !!o.task);
    const labels = fixes.map((f) => fixLabel(f, o.kind));
    void vscode.window.showWarningMessage(`Review of ${id} stopped: ${reason}`, ...labels, 'Open').then((c) => {
      const fix = fixes[labels.indexOf(c ?? '')];
      if (fix) void this.fix(id, fix).catch((e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)));
      else if (c) this.deps.openTicket(id);
    });
  }

  /** Pauses an agent that hit Claude's usage limit: its chat goes on by itself when the limit resets. */
  private async pause(
    id: string,
    o: { phase: 'review' | 'work'; session: string; agent: string; resume: 'working' | 'reviewing' | 'revising'; limit: UsageLimit },
  ): Promise<void> {
    const until = o.limit.until;
    await this.setReview(id, (r) => ({
      ...(r ?? { round: 0, reviewer: '' }),
      state: 'paused',
      paused: { until: until.toISOString(), known: o.limit.known, phase: o.phase, session: o.session, agent: o.agent, resume: o.resume },
    }));
    const what = o.limit.kind === 'usage' ? "Claude's usage limit" : o.limit.kind === 'rate' ? "Claude's rate limit" : 'Claude being overloaded';
    const when = until.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    await this.note(id, `${o.agent} stopped on ${what}. It goes on by itself ${o.limit.known ? `when it resets (${when})` : `at ${when}, and tries again after that if it must`}.`);
    this.scheduleResume();
  }

  /** The next resume, timed to the earliest paused agent. */
  private scheduleResume(): void {
    void this.deps.backlog.read().then((d) => {
      const next = d.items.flatMap((i) => (i.review?.state === 'paused' && i.review.paused ? [Date.parse(i.review.paused.until)] : [])).sort((a, b) => a - b)[0];
      clearTimeout(this.resumeTimer);
      if (next === undefined) return;
      this.resumeTimer = setTimeout(() => void this.resumePaused(), Math.min(Math.max(1000, next - Date.now()), 2 ** 31 - 1));
    });
  }

  /** The earliest time paused agents go on (for the autopilot: no new work starts before). */
  async pausedUntil(): Promise<Date | undefined> {
    const d = await this.deps.backlog.read();
    const times = d.items.flatMap((i) => (i.review?.state === 'paused' && i.review.paused?.known !== undefined ? [Date.parse(i.review.paused.until)] : []));
    const next = times.filter((t) => t > Date.now()).sort((a, b) => a - b)[0];
    return next === undefined ? undefined : new Date(next);
  }

  /** Paused agents whose limit has reset go on (in the leading window only; now, for force). */
  async resumePaused(force?: string): Promise<void> {
    if (!force && this.deps.isLeader && !this.deps.isLeader()) return;
    const d = await this.deps.backlog.read();
    for (const item of d.items) {
      const p = item.review?.state === 'paused' ? item.review.paused : undefined;
      if (!p || this.runs.has(item.id)) continue;
      if (force ? force !== item.id : Date.parse(p.until) > Date.now()) continue;
      // Short of memory: it goes on once there's room (the minute's check tries again); a manual resume asks first.
      if (memoryShortage() && !(force && (await confirmMemory(`${p.agent}'s chat`)))) return;
      const ws = this.worktreeOf(item);
      if (!validSession(p.session)) {
        await this.stopLoop(item.id, `its paused chat isn't a valid session (${p.session.slice(0, 40)}).`, { kind: 'chat-gone' });
        continue;
      }
      const run = runAgentHeadless({
        cwd: ws?.worktree.path ?? this.deps.mainRoot,
        resume: p.session,
        prompt: resumeAfterLimitPrompt(p.phase),
        name: `${p.agent} · ${p.phase === 'review' ? `review ${item.id}` : item.id}`,
        choice: agentChoice(item, p.phase === 'review' ? 'review' : 'work'),
        output: this.deps.output,
      });
      this.runs.set(item.id, run);
      void trackProgress('backlog', `${p.agent} goes on with ${item.id}`, () => run.done);
      await this.setReview(item.id, (r) => ({ ...r!, state: p.resume, paused: undefined }));
      // "chat for agent <name>": the ticket links the note to the chat.
      await this.note(item.id, `The limit reset: resumed the chat for agent ${p.agent} to go on.`);
      void run.done.then((result) => (p.phase === 'review' ? this.afterReview(item.id, run, result) : this.afterRevision(item.id, run, result)));
    }
    this.scheduleResume();
  }

  /** The number of agents running for items now, in this window (the autopilot keeps to its maximum). */
  get running(): number {
    return this.runs.size;
  }

  /**
   * Starts an agent on an item's work, without a window (for the autopilot): it reports in the ticket, asks there when
   * it must ("Waiting for you."), and its "Ready for review." goes on to review.
   */
  async startWork(item: BacklogItem, ws: Workstream): Promise<void> {
    if (!ws.worktree.path || !ws.worktree.branch || this.runs.has(item.id)) return;
    const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
    const agent = agentName(taken);
    const ticket = await this.deps.backlog.ensureDocument(item);
    const guide = path.join(this.deps.backlog.dir, GUIDE);
    const choice = agentChoice(item);
    const task: RevisionTask = { prompt: AUTOPILOT_NOTE, why: 'the autopilot started it' };
    const run = runAgentHeadless({
      cwd: ws.worktree.path,
      prompt: [agentLead(item, agent), agentPrompt(item, ticket, ws.worktree.branch, agent, guide), AUTOPILOT_NOTE].join('\n\n'),
      name: `${agent} · ${item.id}`,
      choice,
      output: this.deps.output,
    });
    this.runs.set(item.id, run);
    this.tasks.set(item.id, task);
    void trackProgress('backlog', `${agent} is working on ${item.id} (autopilot)`, () => run.done);
    await this.setReview(item.id, (r) => ({
      ...(r ?? { round: 0, reviewer: '' }),
      state: 'working',
      autopilot: true,
      implementer: agent,
      implementerSession: run.sessionId,
      worktree: ws.key,
      reason: undefined,
      stop: undefined,
    }));
    await this.note(item.id, `Autopilot: opened a chat for agent ${agent}${describeChoice(choice)} in worktree \`${workstreamLabel(ws)}\`. It works without a window and reports here.`);
    void run.done.then((result) => this.afterRevision(item.id, run, result));
  }

  /** Fixes a stopped review (a button on the ticket or the notification). */
  async fix(id: string, fix: ReviewFix): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const r = item?.review;
    if (!item || !r || this.runs.has(id)) return;
    if (fix === 'resumeNow') return this.resumePaused(id);
    const task: RevisionTask | undefined =
      r.stop?.task ??
      (r.reviewer && r.stop?.kind !== 'no-verdict' && r.stop?.kind !== 'no-worktree'
        ? { prompt: revisionPrompt({ item, reviewer: r.reviewer, ticket: this.deps.backlog.docPath(id), round: r.round }), why: `${r.reviewer} requested changes` }
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
  private chatById(session: string | undefined): { ws: Workstream; id: string; cwd?: string; state: string } | undefined {
    if (!session) return undefined;
    for (const ws of this.deps.repository.current) {
      const chat = ws.chats.find((c) => c.id === session);
      if (chat) return { ws, id: chat.id, cwd: chat.cwd, state: chat.state };
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

  /** Stops the loop: the running agent, if any, and the handoffs. */
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    this.runs.delete(id);
    this.deferred.delete(id);
    run?.stop();
    await this.stopLoop(id, 'stopped by you.', { kind: 'user', notify: false });
  }

  /** `restart`: a loop that stopped or ended starts over at round 1 (the stored round is left as it is). */
  private async startRound(item: BacklogItem, manual = false, restart = false): Promise<void> {
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
    if (!(await this.mayStart(item, manual, (fresh) => this.startRound(fresh, false, restart)))) return;
    const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
    const reviewer = item.review?.reviewer || agentName([...taken, item.review?.implementer ?? '']);
    const base = (await resolveBase(this.deps.mainRoot, readSettings().defaultBase)) ?? 'HEAD';
    const ticket = await this.deps.backlog.ensureDocument(item);
    const prompt = reviewerPrompt({ item, reviewer, implementer: item.review?.implementer, ticket, branch: ws.worktree.branch, base, round });
    // Checked where the agent starts: the awaits above may have let another start for the item in.
    if (this.runs.has(item.id)) return;
    const run = runAgentHeadless({
      cwd: ws.worktree.path,
      prompt: round === 1 || !validSession(item.review?.reviewerSession) ? prompt : prompt.split('\n\n').slice(1).join('\n\n'),
      resume: round > 1 ? validSession(item.review?.reviewerSession) : undefined,
      name: `${reviewer} · review ${item.id}`,
      choice: agentChoice(item, 'review'),
      output: this.deps.output,
    });
    this.runs.set(item.id, run);
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
    await this.note(
      item.id,
      `Review round ${round}: ${round > 1 && item.review?.reviewerSession ? 'resumed' : 'opened'} a chat for agent ${reviewer}${describeChoice(agentChoice(item, 'review'))} in worktree \`${workstreamLabel(ws)}\`. It reviews ${item.review?.implementer ?? 'the work'} and gives a verdict here.`,
    );
    void run.done.then((result) => this.afterReview(item.id, run, result));
  }

  private async afterReview(id: string, run: AgentRun, result: AgentResult): Promise<void> {
    if (this.runs.get(id) !== run) return; // stopped
    this.runs.delete(id);
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
    if (verdict.verdict === 'approved') {
      await this.setReview(id, (r) => ({ ...r!, state: 'approved', handled }));
      void vscode.window
        .showInformationMessage(`${item.review.reviewer} approved ${id} "${item.title}". It's ready for you to merge.`, 'Open')
        .then((c) => c && this.deps.openTicket(id));
      return;
    }
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
    const revising: BacklogItem = { ...item, status: 'doing', review: { ...item.review, state: 'revising', handled } };
    await this.startRevision(revising, task);
  }

  /**
   * The user's review: approved ends the loop; changes requested send the item back to its implementer (its chat
   * resumed, or a new agent), which may ask for more context first. Either stops an agent running for it.
   */
  async userReview(id: string, verdict: Verdict, text: string): Promise<void> {
    const run = this.runs.get(id);
    this.runs.delete(id);
    // What the user decides now replaces a start that waited for memory.
    this.deferred.delete(id);
    run?.stop();
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    const ticket = await this.deps.backlog.readTicket(item);
    const entry = { date: entryDate(new Date()), author: 'You', body: userReviewBody(verdict, text) };
    await this.deps.backlog.writeTicket(id, { ...ticket, activity: [...ticket.activity, entry] });
    const handled = [...(item.review?.handled ?? []), this.key(id)(entry)];
    if (verdict === 'approved') {
      await this.setReview(id, (r) => ({ ...(r ?? { round: 0, reviewer: '' }), state: 'approved', byUser: true, reason: undefined, handled }));
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
    await this.startRevision(
      { ...item, status: 'doing', review },
      { prompt: userRevisionPrompt({ item, ticket: this.deps.backlog.docPath(id), feedback: text }), why: 'you requested changes' },
      { manual: true },
    );
  }

  /** The user answered the implementer's question: it's resumed with the answer. */
  private async answer(item: BacklogItem, answer: string, keys: string[]): Promise<void> {
    const review: ReviewState = { ...item.review!, state: 'revising', handled: [...(item.review!.handled ?? []), ...keys] };
    await this.setReview(item.id, () => review);
    await this.startRevision(
      { ...item, review },
      { prompt: answerPrompt({ item, ticket: this.deps.backlog.docPath(item.id), answer }), why: 'you answered', resumeOnly: true },
    );
  }

  /** Hands the requested changes to the implementer: its chat resumed, or a new agent if it has none. */
  private async startRevision(item: BacklogItem, task: RevisionTask, o: { fresh?: boolean; manual?: boolean } = {}): Promise<void> {
    const review = item.review!;
    const ws = this.worktreeOf(item);
    if (!ws?.worktree.path || !ws.worktree.branch) {
      await this.stopLoop(item.id, 'its worktree is gone.', { kind: 'no-worktree', task });
      return;
    }
    const ticket = this.deps.backlog.docPath(item.id);
    // Its chat (as the repository sees it now: it may be open and busy), unless a new agent is asked for.
    const known = this.chatById(review.implementerSession) ?? this.chatOf(review.implementer);
    const session = validSession(review.implementerSession);
    const chat = o.fresh ? undefined : (known ?? (session ? { id: session, cwd: undefined, state: 'done' } : undefined));
    if (chat && (chat.state === 'working' || chat.state === 'waiting-for-input') && !isRunningHeadless(chat.id)) {
      await this.stopLoop(item.id, `${review.implementer} is still busy in its chat: give it the request there, or hand it to a new agent.`, { kind: 'busy', task });
      return;
    }
    if (!(await this.mayStart(item, !!o.manual, (fresh) => this.startRevision(fresh, task, { ...o, manual: false })))) return;
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
        choice: agentChoice(item),
        output: this.deps.output,
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
        prompt: [agentLead(item, implementer), agentPrompt(item, ticket, ws.worktree.branch, implementer, guide), task.prompt].join('\n\n'),
        name: `${implementer} · ${item.id}`,
        choice: agentChoice(item),
        output: this.deps.output,
      });
    }
    this.runs.set(item.id, run);
    void trackProgress('backlog', `${implementer} is working on ${item.id}: ${task.why}`, () => run.done);
    await this.setReview(item.id, (r) => ({ ...r!, implementer, implementerSession: run.sessionId, stop: undefined, reason: undefined }));
    this.tasks.set(item.id, task);
    // "chat for agent <name>": the ticket links the note to the chat by it.
    const where = `a chat for agent ${implementer}${describeChoice(agentChoice(item))} in worktree \`${workstreamLabel(ws)}\``;
    await this.note(
      item.id,
      task.resumeOnly
        ? `You answered ${implementer}'s question; resumed ${where} to go on.`
        : `Review round ${review.round}: ${task.why}; ${chat ? 'resumed' : 'opened'} ${where} to make them.`,
    );
    void run.done.then((result) => this.afterRevision(item.id, run, result));
  }

  private async afterRevision(id: string, run: AgentRun, result: AgentResult): Promise<void> {
    if (this.runs.get(id) !== run) return;
    this.runs.delete(id);
    const error = result.error;
    if (result.limit) {
      const r = (await this.deps.backlog.read()).items.find((i) => i.id === id)?.review;
      await this.pause(id, { phase: 'work', session: run.sessionId, agent: r?.implementer ?? 'The agent', resume: r?.state === 'working' ? 'working' : 'revising', limit: result.limit });
      return;
    }
    // A "Ready for review" report sends it to review (the scan sees it), and the next round starts.
    this.schedule();
    await this.queue;
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if ((item?.review?.state === 'revising' || item?.review?.state === 'working') && item.status !== 'review') {
      // It asked the user something: it waits for their answer (a comment).
      const ticket = await this.deps.backlog.readTicket(item);
      const last = ticket.activity.filter((e) => sameAgent(entryAgent(e.author), item.review!.implementer)).at(-1);
      if (last && saysWaitingForUser(last.body)) {
        await this.setReview(id, (r) => ({ ...r!, state: 'asking', handled: [...(r!.handled ?? []), this.key(id)(last)] }));
        void vscode.window
          .showInformationMessage(`${item.review.implementer} has a question about ${id} "${item.title}". Answer it in a comment on the ticket.`, 'Open')
          .then((c) => c && this.deps.openTicket(id));
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
