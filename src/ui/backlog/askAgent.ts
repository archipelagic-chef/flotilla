import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentName, type BacklogItem } from '../../features/backlog/backlog';
import { askPrompt, chatBusy, findImplementer, whoAnswers, type AnswerView, type Implementer } from '../../features/backlog/askAgent';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { shapingTools } from '../../features/backlog/shaping';
import { entryAnchors, entryDate, parseReply, replyLine } from '../../features/backlog/ticket';
import { nowLine } from '../../features/chats/activity';
import type { Workstream } from '../../features/workstreams/workstream';
import { trackProgress } from '../progress';
import { agentChoice, isRunningHeadless, runAgentHeadless, runningAgentCount, type AgentResult, type AgentRun } from './agentRunner';

export interface AskAgentDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  /** The main worktree: a fresh answerer reads the code there (it changes none of it). */
  mainRoot: string;
  output: vscode.OutputChannel;
  /** The review loop, as far as asking needs it: whether it runs an agent on a ticket, and how many may run. */
  reviews?: { isRunning(id: string): boolean; readonly limit: number; readonly maxPrioritized: number };
  /** Whether a ticket's tab is open (its reply is seen there), and opening it. */
  isOpen(id: string): boolean;
  open(id: string): Promise<void>;
}

/** A comment asked about: its ticket and anchor, how it shows, and its answerer's run while it thinks. */
interface Ask {
  id: string;
  anchor: string;
  view: AnswerView;
  run?: AgentRun;
  /** Answer Now: a fresh agent answers, not the busy implementer. */
  now?: boolean;
}

/**
 * Ask an Agent (BL-127): an agent answers a comment of yours now, as a reply to it. The implementer answers in its
 * chat, resumed (once its turn ends, when it's busy); a fresh agent on a ticket nobody has worked on, or on Answer Now.
 * The reply is its final message, written into the ticket only when it's done: Stop leaves nothing. It starts at once,
 * above flotilla.agents.maxRunning as Prioritize does (within maxPrioritized), since you're waiting for it.
 */
export class AskAgent implements vscode.Disposable {
  private readonly asks = new Map<string, Ask>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with the ticket whose comments changed how they show. */
  readonly onDidChange = this.changed.event;
  private readonly watchers: vscode.Disposable[];

  constructor(private readonly deps: AskAgentDeps) {
    this.watchers = [deps.repository.onDidChange(() => this.follow())];
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.asks.forEach((a) => a.run?.stop());
    this.changed.dispose();
  }

  /** How a ticket's comments asked about show, by their anchors. */
  viewsOf(id: string): Record<string, AnswerView> {
    const views: Record<string, AnswerView> = {};
    for (const a of this.asks.values()) if (a.id === id) views[a.anchor] = a.view;
    return views;
  }

  /** Whether an answerer runs on a ticket now. */
  isRunning(id: string): boolean {
    return [...this.asks.values()].some((a) => a.id === id && !!a.run);
  }

  /**
   * Asks an agent to answer a comment (anchor): Ask an Agent, Retry, and Answer Now (now: a fresh agent, even while
   * the implementer is busy). Nothing happens while it's being answered already.
   */
  async ask(id: string, anchor: string, o: { now?: boolean } = {}): Promise<void> {
    const key = `${id} ${anchor}`;
    const was = this.asks.get(key);
    if (was && (was.run || was.view.state === 'thinking' || (was.view.state === 'waiting' && !o.now))) return;
    // Claimed before any await: a second click meanwhile finds it.
    const ask: Ask = { id, anchor, view: { agent: was?.view.agent ?? 'An agent', state: 'thinking', since: new Date().toISOString() }, ...(o.now ? { now: true } : {}) };
    this.asks.set(key, ask);
    try {
      await this.start(ask);
    } catch (e) {
      this.fail(ask, e instanceof Error ? e.message : String(e));
    }
    this.changed.fire(id);
  }

  /** Stop: its answerer ends now, writing nothing (or a waiting comment isn't given to the implementer). Retry is offered. */
  stop(id: string, anchor: string): void {
    const ask = this.asks.get(`${id} ${anchor}`);
    if (!ask || (ask.view.state !== 'thinking' && ask.view.state !== 'waiting')) return;
    const run = ask.run;
    ask.run = undefined;
    ask.view = { agent: ask.view.agent, state: 'stopped' };
    run?.stop();
    this.changed.fire(id);
  }

  /** The ticket's implementer, as the chats are now: busy while its chat works, or the review loop runs it. */
  private implementer(item: BacklogItem): Implementer | undefined {
    const chats = this.deps.repository.current.flatMap((ws) => ws.chats.map((c) => ({ ...c, cwd: c.cwd ?? ws.worktree.path })));
    const found = findImplementer(chats, item);
    if (!found) return undefined;
    const running = chatBusy(found) || isRunningHeadless(found.id) || !!this.deps.reviews?.isRunning(item.id);
    return { agent: found.agent, session: found.id, ...(found.cwd ? { cwd: found.cwd } : {}), running };
  }

  private async start(ask: Ask): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === ask.id);
    if (!item) throw new Error('the ticket is gone');
    const activity = (await this.deps.backlog.readTicket(item)).activity;
    const entry = activity[entryAnchors(activity).indexOf(ask.anchor)];
    if (!entry) throw new Error('the comment is gone');
    const who = whoAnswers({ implementer: this.implementer(item), now: ask.now, discussionAgent: item.shaping?.agent });
    if (who.kind === 'wait') {
      ask.view = { agent: who.agent, state: 'waiting' };
      return;
    }
    const limit = this.deps.reviews ? this.deps.reviews.limit + this.deps.reviews.maxPrioritized : Infinity;
    if (runningAgentCount() >= limit) {
      throw new Error(`${runningAgentCount()} agents are running, as many as flotilla.agents.maxRunning and maxPrioritized allow`);
    }
    const ticket = await this.deps.backlog.ensureDocument(item);
    const comment = { date: entry.date, author: entry.author, text: parseReply(entry.body)?.text ?? entry.body };
    const agent = who.kind === 'implementer' ? who.agent : (who.agent ?? agentName(this.takenNames()));
    const common = { choice: agentChoice(item), output: this.deps.output, track: { ticket: item.id, agent, role: 'reply' as const } };
    const run =
      who.kind === 'implementer'
        ? runAgentHeadless({ ...common, cwd: who.cwd ?? this.deps.mainRoot, resume: who.session, prompt: askPrompt({ item, ticket, comment }), name: `${agent} · ${item.id}` })
        : runAgentHeadless({
            ...common,
            cwd: this.deps.mainRoot,
            prompt: askPrompt({ item, ticket, comment, fresh: { agent } }),
            name: `${agent} · answering on ${item.id}`,
            tools: shapingTools(ticket),
          });
    ask.run = run;
    ask.view = { agent, state: 'thinking', since: new Date().toISOString() };
    void trackProgress('backlog', `${agent} is answering your comment on ${item.id}`, () => run.done);
    void run.done.then((result) => this.finished(ask, run, result)).catch((e: unknown) => this.fail(ask, String(e)));
  }

  /** Its answerer is done: its final message goes into the ticket as the reply; you hear of it when the ticket isn't open. */
  private async finished(ask: Ask, run: AgentRun, result: AgentResult): Promise<void> {
    // Stopped (or asked again): there's nothing to write.
    if (ask.run !== run || this.asks.get(`${ask.id} ${ask.anchor}`) !== ask) return;
    ask.run = undefined;
    const agent = ask.view.agent;
    const reply = result.reply?.trim();
    if (result.limit) return this.fail(ask, `a usage limit (${result.limit.kind})`);
    if (result.error) return this.fail(ask, result.error.slice(0, 200));
    if (!reply) return this.fail(ask, 'no reply');
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === ask.id);
    if (!item) return this.fail(ask, 'the ticket is gone');
    const activity = (await this.deps.backlog.readTicket(item)).activity;
    const parent = activity[entryAnchors(activity).indexOf(ask.anchor)];
    await this.deps.backlog.appendActivity(item, {
      date: entryDate(new Date()),
      author: `Agent ${agent}`,
      body: parent ? `${replyLine(parent, ask.anchor)}\n${reply}` : reply,
    });
    ask.view = { agent, state: 'answered' };
    this.changed.fire(ask.id);
    if (!this.deps.isOpen(ask.id)) {
      await this.deps.backlog.change((d) => ({ ...d, items: d.items.map((i) => (i.id === ask.id ? { ...i, unseenReplies: (i.unseenReplies ?? 0) + 1 } : i)) }));
      void vscode.window.showInformationMessage(`${agent} replied to your comment on ${ask.id}.`, 'Open').then((pick) => pick && this.deps.open(ask.id));
    }
    this.follow();
  }

  private fail(ask: Ask, error: string): void {
    ask.run?.stop();
    ask.run = undefined;
    ask.view = { agent: ask.view.agent, state: 'failed', error };
    this.deps.output.appendLine(`Ask an Agent on ${ask.id}: ${error}`);
    this.changed.fire(ask.id);
  }

  /**
   * The chats changed: a comment waiting for its implementer starts once its turn has ended, and a thinking one shows
   * what its answerer does now.
   */
  private follow(): void {
    for (const ask of this.asks.values()) {
      if (ask.view.state === 'waiting' && !ask.run) {
        void this.startWaiting(ask);
      } else if (ask.view.state === 'thinking' && ask.run) {
        const session = ask.run.sessionId;
        const chat = this.deps.repository.current.flatMap((w) => w.chats).find((c) => c.id === session);
        const now = chat?.activity && nowLine(chat.activity)?.text;
        if (now && now !== ask.view.now) {
          ask.view = { ...ask.view, now };
          this.changed.fire(ask.id);
        }
      }
    }
  }

  private readonly checking = new Set<Ask>();

  private async startWaiting(ask: Ask): Promise<void> {
    if (this.checking.has(ask)) return;
    this.checking.add(ask);
    try {
      const item = (await this.deps.backlog.read()).items.find((i) => i.id === ask.id);
      if (!item || this.implementer(item)?.running || ask.view.state !== 'waiting') return;
      await this.start(ask);
      this.changed.fire(ask.id);
    } catch (e) {
      this.fail(ask, e instanceof Error ? e.message : String(e));
    } finally {
      this.checking.delete(ask);
    }
  }

  /** The names of agents in the repository's chats: a new agent's name is none of them. */
  private takenNames(): string[] {
    return this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
  }
}
