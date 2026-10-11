import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentLead, agentName, branchMatches, sameAgent, updateItem, type BacklogItem, type BacklogStatus } from '../../features/backlog/backlog';
import { GUIDE } from '../../features/backlog/inbox';
import { LocalBacklog } from '../../features/backlog/localBacklog';
import { readyReport, reviewerPrompt, revisionPrompt, verdictReport, type ReviewState } from '../../features/backlog/review';
import { entryDate, type TicketEntry } from '../../features/backlog/ticket';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { agentPrompt } from '../commands';
import { workstreamLabel } from '../format';
import { readSettings } from '../settings';
import { runAgentHeadless, type AgentRun } from './agentRunner';
import { trackProgress } from '../progress';

export interface ReviewDeps {
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
export class ReviewLoop implements vscode.Disposable {
  /** Each item's status when last seen: a move into review starts a round. */
  private readonly statuses = new Map<string, BacklogStatus>();
  /** Reports already there when Flotilla first saw an item: old news, not acted on. */
  private readonly baseline = new Map<string, string[]>();
  /** The agent running for an item (reviewer or implementer). */
  private readonly runs = new Map<string, AgentRun>();
  private queue: Promise<void> = Promise.resolve();
  private readonly watcher: vscode.Disposable;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: ReviewDeps) {
    this.watcher = deps.backlog.watch(() => this.schedule());
    this.schedule();
  }

  dispose(): void {
    this.watcher.dispose();
    this.runs.forEach((r) => r.stop());
    this.changed.dispose();
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /** One scan at a time: they read and write backlog.json. */
  private schedule(): void {
    this.queue = this.queue.then(() => this.scan()).catch((e: unknown) => this.deps.output.appendLine(`Review loop: ${e instanceof Error ? e.message : String(e)}`));
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
      if (!automatic || this.runs.has(item.id) || item.proposed) continue;
      // An implementer that reports "Ready for review" sends its item to review.
      if (item.status === 'doing' || item.status === 'todo') {
        const ticket = await this.deps.backlog.readTicket(item);
        const seen = { ...(item.review ?? { round: 0, state: 'revising' as const, reviewer: '' }), handled: [...(item.review?.handled ?? []), ...(this.baseline.get(item.id) ?? [])] };
        const ready = readyReport(ticket.activity, seen, this.key(item.id));
        if (ready) {
          await this.setReview(item.id, (r) => ({
            ...(r ?? { round: 0, state: 'revising', reviewer: '' }),
            implementer: r?.implementer ?? ready.agent,
            handled: [...(r?.handled ?? []), this.key(item.id)(ready.entry)],
          }), 'review');
          continue;
        }
      }
      if (item.status === 'review' && before !== 'review' && item.review?.state !== 'reviewing') await this.start(item.id);
    }
  }

  private async setReview(id: string, change: (r: ReviewState | undefined) => ReviewState, status?: BacklogStatus): Promise<void> {
    await this.deps.backlog.change((d) => ({
      ...d,
      items: d.items.map((i) => (i.id === id ? { ...i, review: change(i.review), ...(status ? { status } : {}) } : i)),
    }));
    this.changed.fire();
  }

  private async note(id: string, body: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item) return;
    const ticket = await this.deps.backlog.readTicket(item);
    await this.deps.backlog.writeTicket(id, { ...ticket, activity: [...ticket.activity, { date: entryDate(new Date()), author: 'Flotilla', body }] });
  }

  private async stopLoop(id: string, reason: string, notify = true): Promise<void> {
    await this.setReview(id, (r) => ({ ...(r ?? { round: 0, reviewer: '' }), state: 'stopped', reason }));
    await this.note(id, `The review stopped: ${reason}`);
    if (notify) void vscode.window.showWarningMessage(`Review of ${id} stopped: ${reason}`, 'Open').then((c) => c && this.deps.openTicket(id));
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
    const all = this.deps.repository.current.filter((w) => !w.worktree.isMain && w.worktree.path && w.worktree.branch && branchMatches(item, w.worktree.branch));
    return (
      all.find((w) => w.key === item.review?.worktree) ??
      all.find((w) => w.key === this.chatOf(item.review?.implementer)?.ws.key) ??
      all[0]
    );
  }

  /** Starts a review round now (Start Review, or a move into review). */
  async start(id: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item || this.runs.has(id)) return;
    if (item.status !== 'review') {
      this.statuses.set(id, 'review');
      await this.deps.backlog.change((d) => updateItem(d, id, { status: 'review' }));
    }
    // A loop that stopped or ended starts over in its rounds count.
    const fresh = item.review && item.review.state !== 'revising' ? { ...item, review: { ...item.review, round: 0 } } : item;
    await this.startRound(fresh);
  }

  /** Stops the loop: the running agent, if any, and the handoffs. */
  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    this.runs.delete(id);
    run?.stop();
    await this.stopLoop(id, 'stopped by you.', false);
  }

  private async startRound(item: BacklogItem): Promise<void> {
    const max = Math.max(1, settings().get<number>('review.maxRounds', 3));
    const round = (item.review?.round ?? 0) + 1;
    if (round > max) {
      await this.stopLoop(item.id, `still not approved after ${max} rounds; it's yours to decide.`);
      return;
    }
    const ws = this.worktreeOf(item);
    if (!ws?.worktree.path || !ws.worktree.branch) {
      await this.stopLoop(item.id, 'it has no worktree to review.');
      return;
    }
    const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
    const reviewer = item.review?.reviewer || agentName([...taken, item.review?.implementer ?? '']);
    const base = (await resolveBase(this.deps.mainRoot, readSettings().defaultBase)) ?? 'HEAD';
    const ticket = await this.deps.backlog.ensureDocument(item);
    const prompt = reviewerPrompt({ item, reviewer, implementer: item.review?.implementer, ticket, branch: ws.worktree.branch, base, round });
    const run = runAgentHeadless({
      cwd: ws.worktree.path,
      prompt: round === 1 || !item.review?.reviewerSession ? prompt : prompt.split('\n\n').slice(1).join('\n\n'),
      resume: round > 1 ? item.review?.reviewerSession : undefined,
      name: `${reviewer} · review ${item.id}`,
      output: this.deps.output,
    });
    this.runs.set(item.id, run);
    void trackProgress('backlog', `${reviewer} is reviewing ${item.id}`, () => run.done);
    await this.setReview(item.id, (r) => ({ ...(r ?? { reviewer }), round, state: 'reviewing', reviewer, reviewerSession: run.sessionId, worktree: ws.key, reason: undefined }));
    await this.note(item.id, `Review round ${round}: ${round > 1 && item.review?.reviewerSession ? 'resumed' : 'opened'} a chat for agent ${reviewer} in worktree \`${workstreamLabel(ws)}\`. It reviews ${item.review?.implementer ?? 'the work'} and gives a verdict here.`);
    void run.done.then((result) => this.afterReview(item.id, run, result.error));
  }

  private async afterReview(id: string, run: AgentRun, error?: string): Promise<void> {
    if (this.runs.get(id) !== run) return; // stopped
    this.runs.delete(id);
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item?.review) return;
    const ticket = await this.deps.backlog.readTicket(item);
    const verdict = verdictReport(ticket.activity, item.review, this.key(id));
    if (!verdict) {
      await this.stopLoop(id, `${item.review.reviewer} finished without a verdict${error ? ` (${error.slice(0, 200)})` : ''}.`);
      return;
    }
    const handled = [...(item.review.handled ?? []), this.key(id)(verdict.entry)];
    if (verdict.verdict === 'approved') {
      await this.setReview(id, (r) => ({ ...r!, state: 'approved', handled }));
      void vscode.window.showInformationMessage(`${item.review.reviewer} approved ${id} "${item.title}". It's ready for you to merge.`, 'Open').then((c) => c && this.deps.openTicket(id));
      return;
    }
    const max = Math.max(1, settings().get<number>('review.maxRounds', 3));
    if (item.review.round >= max) {
      await this.setReview(id, (r) => ({ ...r!, handled }));
      await this.stopLoop(id, `${item.review.reviewer} still requests changes after ${max} rounds; it's yours to decide.`);
      return;
    }
    this.statuses.set(id, 'doing');
    await this.setReview(id, (r) => ({ ...r!, state: 'revising', handled }), 'doing');
    await this.startRevision({ ...item, status: 'doing', review: { ...item.review, state: 'revising', handled } });
  }

  /** Hands the requested changes to the implementer: its chat resumed, or a new agent if it has none. */
  private async startRevision(item: BacklogItem): Promise<void> {
    const review = item.review!;
    const ws = this.worktreeOf(item);
    if (!ws?.worktree.path || !ws.worktree.branch) {
      await this.stopLoop(item.id, 'its worktree is gone.');
      return;
    }
    const ticket = this.deps.backlog.docPath(item.id);
    const chat = review.implementerSession ? { id: review.implementerSession, cwd: undefined, state: 'done' } : this.chatOf(review.implementer);
    if (chat && (chat.state === 'working' || chat.state === 'waiting-for-input')) {
      await this.stopLoop(item.id, `${review.implementer} is still busy in its chat: give it the review there.`);
      return;
    }
    let run: AgentRun;
    let implementer = review.implementer;
    if (chat) {
      // Its chat ran in the folder it was started in: resumed there, it keeps everything it knew.
      run = runAgentHeadless({
        cwd: chat.cwd ?? ws.worktree.path,
        resume: chat.id,
        prompt: revisionPrompt({ item, reviewer: review.reviewer, ticket, round: review.round }),
        name: `${implementer} · ${item.id}`,
        output: this.deps.output,
      });
    } else {
      const taken = this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
      implementer = agentName([...taken, review.reviewer]);
      const guide = path.join(this.deps.backlog.dir, GUIDE);
      run = runAgentHeadless({
        cwd: ws.worktree.path,
        prompt: [
          agentLead(item, implementer),
          agentPrompt(item, ticket, ws.worktree.branch, implementer, guide),
          revisionPrompt({ item, reviewer: review.reviewer, ticket, round: review.round }),
        ].join('\n\n'),
        name: `${implementer} · ${item.id}`,
        output: this.deps.output,
      });
    }
    this.runs.set(item.id, run);
    void trackProgress('backlog', `${implementer} is making the changes ${review.reviewer} asked for on ${item.id}`, () => run.done);
    await this.setReview(item.id, (r) => ({ ...r!, implementer, implementerSession: run.sessionId }));
    await this.note(item.id, `Review round ${review.round}: ${review.reviewer} requested changes; ${chat ? 'resumed' : 'opened'} a chat for agent ${implementer} in worktree \`${workstreamLabel(ws)}\` to make them.`);
    void run.done.then((result) => this.afterRevision(item.id, run, result.error));
  }

  private async afterRevision(id: string, run: AgentRun, error?: string): Promise<void> {
    if (this.runs.get(id) !== run) return;
    this.runs.delete(id);
    // A "Ready for review" report sends it to review (the scan sees it), and the next round starts.
    this.schedule();
    await this.queue;
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (item?.review?.state === 'revising' && item.status !== 'review') {
      await this.stopLoop(id, `${item.review.implementer} stopped without reporting "Ready for review"${error ? ` (${error.slice(0, 200)})` : ''}.`);
    }
  }
}
