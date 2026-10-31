import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import {
  agentChatItem,
  agentName,
  type BacklogItem,
  updateItem,
} from '../../features/backlog/backlog';
import {
  type Chat,
  transcriptPath,
} from '../../features/chats/chats';
import { AskChat } from '../../features/backlog/askChat';
import {
  DISCUSSION_DONE,
  discussionOpener,
  discussionTurns,
} from '../../features/backlog/discussChat';
import { formatMemory } from '../../features/workstreams/memory';
import {
  CHAT_LINK,
  discussable,
  discussionPrompt,
  findDiscussionChat,
  followUpPrompt,
  readyToStart,
  shapingPrompt,
  shapingTools,
  summarizedSince,
} from '../../features/backlog/shaping';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { entryDate } from '../../features/backlog/ticket';
import type { Workstream } from '../../features/workstreams/workstream';
import { trackProgress } from '../progress';
import type { DiscussionView } from '../../webview/ticketProtocol';
import {
  agentChoice,
  type AgentResult,
  type AgentRun,
  memoryShortage,
  runAgentHeadless,
  spawnDiscussion,
  validSession,
} from './agentRunner';

export interface ShapingDeps {
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  /** The main worktree: the agent reads the code there (it changes none of it). */
  mainRoot: string;
  output: vscode.OutputChannel;
  /** Opens a new Claude Code chat in the main worktree, beside the ticket, its first message (lead, then task) filled in. */
  newChat(lead: string, task: string): Promise<void>;
  /** Opens a chat of a worktree (its key): focused when it's open, resumed when it was closed. */
  openChat(key: string, chatId: string): Promise<void>;
  /** Where Claude Code keeps chats' transcripts (tests: a folder of their own). */
  claudeHome?: string;
}

/** What a ticket's tab gives its Discuss pane: how its answers are rendered, and where its changes go. */
export interface DiscussionHost {
  render(markdown: string): Promise<string>;
  changed(): void;
}

/** A ticket's discussion chat, and the worktree it's listed in. */
export interface DiscussionChat {
  key: string;
  chat: Chat;
}

/**
 * Discussions of tickets nobody works on yet. Discuss opens the ticket with its Discuss pane (BL-241): a chat with the
 * ticket's discussion agent, which opens the conversation, writes what's agreed into the description as they talk, and
 * a summary into the activity when they're done. Its session is kept, so the pane shows it again when the ticket opens.
 * The ticket says "Discussing" while it answers or its pane is open.
 *
 * A discussion started in a Claude Code chat (BL-188) goes on there: Discuss opens that chat, and the ticket notes one
 * closed without a summary.
 *
 * Before that, the agent replied in the ticket, one headless run per comment (BL-45): that run is reply, kept for
 * replying to a comment on request (BL-127) and for the discussions paused that way (Resume goes on with them).
 */
export class Shaping implements vscode.Disposable {
  private readonly runs = new Map<string, AgentRun>();
  /** Tickets whose agent is being started: claimed before the first await, so a second call can't start another. */
  private readonly starting = new Set<string>();
  /** Tickets with a comment that came while their agent was running: answered when it stops. */
  private readonly again = new Set<string>();
  /** Tickets whose discussion chat is being opened (see discuss). */
  private readonly opening = new Set<string>();
  /** Tickets whose discussion chat this window opened, until it closes: this window links and notes them (once). */
  private readonly watching = new Set<string>();
  /** Of those, the ones whose chat was seen open: closing it ends the discussion. */
  private readonly seenOpen = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** The Discuss panes of the open tickets (BL-241): one chat each, its process up while it talks. */
  private readonly panes = new Map<string, { chat: AskChat; host: DiscussionHost; busy: boolean }>();
  /** Discuss was pressed: the ticket's tab (open by now) shows its pane, and focuses it. */
  private readonly focusPane = new vscode.EventEmitter<string>();
  readonly onFocusPane = this.focusPane.event;

  private readonly watchers: vscode.Disposable[];

  constructor(private readonly deps: ShapingDeps) {
    const sync = () => void this.syncChats().catch((e: unknown) => deps.output.appendLine(`Following discussion chats failed: ${String(e)}`));
    this.watchers = [
      // A discussion the user paused or stopped in another window ends here, if it runs here.
      deps.backlog.watch(() => {
        void this.endHeld().catch(() => undefined);
        sync();
      }),
      deps.repository.onDidChange(sync),
    ];
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this.runs.forEach((r) => r.stop());
    this.panes.forEach((p) => p.chat.dispose());
    this.panes.clear();
    this.changed.dispose();
    this.focusPane.dispose();
  }

  /** The session of the ticket's shaping agent if it runs in this window. */
  runningSession(id: string): string | undefined {
    return this.runs.get(id)?.sessionId;
  }

  /** Ends the runs here of discussions the user paused or stopped. */
  private async endHeld(): Promise<void> {
    if (!this.runs.size && !this.panes.size) return;
    for (const item of (await this.deps.backlog.read()).items) {
      const pane = this.panes.get(item.id);
      if (pane && item.shaping?.held && pane.chat.live) {
        pane.chat.halt();
        this.changed.fire();
      }
      const run = this.runs.get(item.id);
      if (!run || !item.shaping?.held || item.shaping.session !== run.sessionId) continue;
      this.runs.delete(item.id);
      this.again.delete(item.id);
      run.stop();
      this.changed.fire();
    }
  }

  /**
   * Pauses, stops or resumes a ticket's discussion: its agent's run ends now (here, or in the window running it), its
   * chat kept; Resume (or a comment) goes on in it.
   */
  async control(id: string, action: 'pause' | 'stop' | 'resume'): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const shaping = item?.shaping;
    if (!item || !shaping) return;
    if (action === 'resume') {
      if (shaping.held && shaping.pane) {
        await this.unhold(id);
        this.focusPane.fire(id);
      } else if (shaping.held) await this.reply(id, true);
      return;
    }
    await this.deps.backlog.change((d) =>
      updateItem(d, id, { shaping: { ...shaping, held: { kind: action === 'pause' ? 'paused' : 'stopped', at: new Date().toISOString() } } }),
    );
    await this.endHeld();
    await this.say(
      item,
      shaping.pane
        ? `You ${action === 'pause' ? 'paused' : 'stopped'} ${shaping.agent}. Its discussion is kept: write in its pane, or Resume, and it goes on.`
        : action === 'pause'
          ? `You paused ${shaping.agent}. Its chat is kept: Resume, and it goes on there.`
          : `You stopped ${shaping.agent}. Resume, and it goes on in its chat.`,
    );
    this.changed.fire();
  }

  /** Whether an agent is replying in the ticket, or talking in its Discuss pane, now (in this window; a discussion chat isn't, see chatOf). */
  isRunning(id: string): boolean {
    return this.runs.has(id) || this.starting.has(id) || !!this.panes.get(id)?.chat.live;
  }

  /** Whether the ticket's Discuss pane is answering, or open in its tab and not summarized yet: its card says "Discussing". */
  isDiscussing(item: Pick<BacklogItem, 'id' | 'shaping'>): boolean {
    const pane = this.panes.get(item.id);
    if (!pane || !item.shaping?.pane) return false;
    return pane.chat.busy || (!item.shaping.pane.ended && !item.shaping.held);
  }

  /** The chat of a ticket's discussion (BL-188), in whichever worktree it's listed; undefined until its first message is sent. */
  chatOf(item: Pick<BacklogItem, 'id' | 'shaping'>): DiscussionChat | undefined {
    const shaping = item.shaping;
    if (!shaping?.chat) return undefined;
    for (const ws of this.deps.repository.current) {
      const chat = findDiscussionChat(ws.chats, { id: item.id, agent: shaping.agent, session: shaping.session });
      if (chat) return { key: ws.key, chat };
    }
    return undefined;
  }

  /** Opens a chat by its session, in whichever worktree it's listed (a note's link to it, see CHAT_LINK). */
  async openSession(session: string): Promise<boolean> {
    const ws = this.deps.repository.current.find((w) => w.chats.some((c) => c.id === session));
    if (!ws) return false;
    await this.deps.openChat(ws.key, session);
    return true;
  }

  /**
   * Discuss (BL-241): the ticket's Discuss pane, its discussion started (its agent opens it) or gone on with. One
   * started in a Claude Code chat (BL-188) opens there. Nothing happens to a ticket that's being worked on.
   */
  async discuss(id: string): Promise<void> {
    if (this.opening.has(id)) return;
    this.opening.add(id);
    try {
      const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
      if (!item || !discussable(item)) return;
      const shaping = item.shaping;
      const found = this.chatOf(item);
      if (shaping && found) {
        if (!shaping.session) await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { ...shaping, session: found.chat.id } }));
        this.watch(id, found.chat.open);
        await this.deps.openChat(found.key, found.chat.id);
        return;
      }
      // A reply running in the ticket (the older way) gives way to the pane.
      const run = this.runs.get(id);
      if (run) {
        this.runs.delete(id);
        run.stop();
      }
      if (!shaping?.pane) {
        const agent = shaping?.agent ?? agentName(this.takenNames());
        await this.deps.backlog.ensureDocument(item);
        const pane = { since: entryDate(new Date()) };
        await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { agent, session: crypto.randomUUID(), pane } }));
        await this.say(
          item,
          `Opened a discussion with agent ${agent} in this ticket's Discuss pane: it starts with what it understood and its questions. It writes what's agreed into the description as you go, and a summary here when you're done.`,
        );
      } else if (shaping.held) await this.unhold(id);
      // Its tab is open by now: it shows the pane (see attach), which starts the discussion when it hasn't started yet.
      this.focusPane.fire(id);
    } finally {
      this.opening.delete(id);
      this.changed.fire();
    }
  }

  /** The user goes on with a paused (or stopped) discussion. */
  private async unhold(id: string): Promise<void> {
    await this.deps.backlog.change((d) => {
      const now = d.items.find((i) => i.id === id)?.shaping;
      return now?.held ? updateItem(d, id, { shaping: { ...now, held: undefined } }) : d;
    });
  }

  /**
   * The ticket's Discuss pane, for its tab (BL-241): its chat as it was kept (read from its session's transcript), and,
   * when it hasn't started yet, its agent asked to open it. Undefined for a ticket that has none.
   */
  async attach(id: string, host: DiscussionHost): Promise<DiscussionView | undefined> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const shaping = item?.shaping;
    if (!item || !shaping?.pane || !discussable(item) || !validSession(shaping.session)) return undefined;
    let pane = this.panes.get(id);
    if (pane) {
      pane.host = host;
      return this.paneView(id);
    }
    const ticket = await this.deps.backlog.ensureDocument(item);
    const { agent, session } = shaping;
    const transcript = () => transcriptPath(this.deps.mainRoot, session, this.deps.claudeHome);
    const chat: AskChat = new AskChat({
      model: agentChoice(item).model ?? 'claude',
      kept: true,
      memoryShort: () => {
        const short = memoryShortage();
        return short && `Waiting for memory: ${formatMemory(short.freeMB)} free, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)}…`;
      },
      context: async () => ({ cwd: this.deps.mainRoot, text: '' }),
      spawn: (cwd) =>
        spawnDiscussion(cwd, {
          instructions: discussionPrompt({ item, agent, ticket }),
          session,
          // Resumed once its session has a transcript (its first message was taken).
          resume: fs.existsSync(transcript()),
          tools: shapingTools(ticket),
          choice: agentChoice(item),
          output: this.deps.output,
          ticket: id,
          agent,
        }),
      render: (markdown) => this.panes.get(id)?.host.render(markdown) ?? Promise.resolve(markdown),
      changed: () => {
        const p = this.panes.get(id);
        if (p?.chat !== chat) return;
        p.host.changed();
        // Its card says "Discussing" while it answers: told when that changes, not at every word.
        if (p.busy !== chat.busy) {
          p.busy = chat.busy;
          this.changed.fire();
        }
      },
      log: (line) => this.deps.output.appendLine(line),
      answered: () => void this.answered(id).catch((e: unknown) => this.deps.output.appendLine(`Discussion of ${id}: ${String(e)}`)),
    });
    pane = { chat, host, busy: false };
    this.panes.set(id, pane);
    let turns: ReturnType<typeof discussionTurns> = [];
    try {
      turns = discussionTurns(await fs.promises.readFile(transcript(), 'utf8'));
    } catch {
      // Not started yet.
    }
    chat.restore(turns);
    this.changed.fire();
    if (!turns.length && !shaping.held) void chat.ask(discussionOpener(item, agent), { opener: true });
    return this.paneView(id);
  }

  /** The ticket's tab closed: its pane's process ends (its session is kept). */
  detach(id: string): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    this.panes.delete(id);
    pane.chat.dispose();
    this.changed.fire();
  }

  /** The ticket's Discuss pane as its tab shows it. */
  async paneView(id: string): Promise<DiscussionView | undefined> {
    const pane = this.panes.get(id);
    const shaping = (await this.deps.backlog.read()).items.find((i) => i.id === id)?.shaping;
    if (!pane || !shaping?.pane) return undefined;
    return { agent: shaping.agent, chat: pane.chat.view(), ended: !!shaping.pane.ended, ...(shaping.held ? { held: shaping.held.kind } : {}) };
  }

  /** The user writes in the Discuss pane (done: Done, the agent writes its summary): a discussion summarized, or paused, goes on. */
  async send(id: string, text: string, o: { done?: boolean } = {}): Promise<void> {
    const pane = this.panes.get(id);
    const message = o.done ? DISCUSSION_DONE : text.trim();
    if (!pane || !message || pane.chat.busy) return;
    await this.deps.backlog.change((d) => {
      const now = d.items.find((i) => i.id === id)?.shaping;
      if (!now?.pane || (!now.held && !now.pane.ended)) return d;
      // Talked on after a summary: the next one is looked for from now, and it isn't ready until it says so again.
      const pane = now.pane.ended ? { since: entryDate(new Date()) } : now.pane;
      return updateItem(d, id, { shaping: { ...now, held: undefined, pane, ...(now.pane.ended ? { ready: undefined } : {}) } });
    });
    await pane.chat.ask(message);
    this.changed.fire();
  }

  /** Stop in the Discuss pane: the answer being written stops, the discussion goes on. */
  stopAnswer(id: string): void {
    this.panes.get(id)?.chat.stop();
  }

  /**
   * An answer in the Discuss pane is finished: when the agent has written its summary since the discussion (or the
   * talk after the last summary) started, the discussion is ended, its process with it, and the ticket says whether the
   * agent thinks it's ready to start.
   */
  private async answered(id: string): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    const shaping = item?.shaping;
    if (!item || !shaping?.pane || shaping.pane.ended) return;
    const activity = (await this.deps.backlog.readTicket(item)).activity;
    if (!summarizedSince(activity, shaping.agent, shaping.pane.since)) return;
    const ready = readyToStart(activity, shaping.agent);
    await this.deps.backlog.change((d) => {
      const now = d.items.find((i) => i.id === id)?.shaping;
      return now?.pane ? updateItem(d, id, { shaping: { ...now, pane: { ...now.pane, ended: true }, ready: ready || undefined } }) : d;
    });
    this.panes.get(id)?.chat.halt();
    this.changed.fire();
  }

  private watch(id: string, open: boolean): void {
    this.watching.add(id);
    if (open) this.seenOpen.add(id);
  }

  /**
   * Follows the discussion chats this window opened: saves a chat's session once its first message is sent, and when
   * it closes, whether the agent says the ticket is ready, and a note when it closed without a summary.
   */
  private async syncChats(): Promise<void> {
    if (!this.watching.size) return;
    const items = (await this.deps.backlog.read()).items;
    let changed = false;
    for (const id of [...this.watching]) {
      const item = items.find((i) => i.id === id);
      const shaping = item?.shaping;
      if (!item || !shaping?.chat) {
        this.watching.delete(id);
        this.seenOpen.delete(id);
        continue;
      }
      const found = this.chatOf(item);
      if (!found) continue;
      if (!shaping.session) {
        await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { ...shaping, session: found.chat.id } }));
        changed = true;
      }
      if (found.chat.open) {
        if (!this.seenOpen.has(id)) changed = true;
        this.seenOpen.add(id);
        continue;
      }
      if (!this.seenOpen.has(id)) continue;
      this.watching.delete(id);
      this.seenOpen.delete(id);
      changed = true;
      const activity = (await this.deps.backlog.readTicket(item)).activity;
      const ready = readyToStart(activity, shaping.agent);
      if (ready) {
        await this.deps.backlog.change((d) => {
          const now = d.items.find((i) => i.id === id)?.shaping;
          return now ? updateItem(d, id, { shaping: { ...now, ready: true } }) : d;
        });
      }
      if (!summarizedSince(activity, shaping.agent, shaping.chat.since)) {
        await this.say(
          item,
          `${shaping.agent}'s chat closed without a summary of the discussion. [Open its chat](${CHAT_LINK}${found.chat.id}) to go on, or press Discuss.`,
        );
      }
    }
    if (changed) this.changed.fire();
  }

  /**
   * Has an agent reply in the ticket (BL-45's way): a headless run answers what the user wrote (opened: without a
   * comment yet), in its chat when it has one. A call while it runs is answered when it stops.
   */
  async reply(id: string, opened = false): Promise<void> {
    // Checked and claimed before any await: a call that comes meanwhile is a comment during the run (Discuss without one
    // needs nothing more), not a second agent.
    if (this.starting.has(id) || this.runs.has(id)) {
      if (!opened) this.again.add(id);
      return;
    }
    this.starting.add(id);
    this.again.delete(id);
    try {
      await this.start(id, opened);
    } finally {
      this.starting.delete(id);
    }
  }

  private async start(id: string, opened: boolean): Promise<void> {
    const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (!item || !discussable(item)) return;
    const ticket = await this.deps.backlog.ensureDocument(item);
    // A discussion chat isn't a headless one: a reply in the ticket starts its own.
    if (item.shaping?.chat || item.shaping?.pane) item.shaping = undefined;
    // The chat is resumed when it's still there; a session id that isn't one (edited by hand) starts a new chat.
    const resume = validSession(item.shaping?.session);
    const agent = item.shaping?.agent ?? agentName(this.takenNames());
    const run = runAgentHeadless({
      cwd: this.deps.mainRoot,
      prompt: resume ? followUpPrompt({ ticket, opened }) : shapingPrompt({ item, agent, ticket }),
      resume,
      name: `${agent} · discussing ${id}`,
      track: { ticket: id, agent, role: 'discuss' },
      choice: agentChoice(item),
      output: this.deps.output,
      tools: shapingTools(ticket),
    });
    try {
      // Saved before the run is tracked: a run that ends meanwhile can't be followed by a stale state. (No longer held:
      // the user resumed it, or wrote again.)
      await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { agent, session: run.sessionId } }));
      if (!item.shaping?.session) {
        await this.say(
          item,
          `Opened a chat for agent ${agent} to discuss this ticket with you. It replies here, and writes what's agreed into the description.`,
        );
      }
    } catch (e) {
      run.stop();
      throw e;
    }
    this.runs.set(id, run);
    void trackProgress('backlog', `${agent} is discussing ${id}`, () => run.done);
    this.changed.fire();
    void run.done.then((result) => this.finished(id, agent, result, run));
  }

  /** Dismisses "ready to start" (Keep discussing): the ticket goes on being discussed. */
  async keepDiscussing(id: string): Promise<void> {
    await this.deps.backlog.change((d) => {
      const shaping = d.items.find((i) => i.id === id)?.shaping;
      return shaping ? updateItem(d, id, { shaping: { ...shaping, ready: undefined } }) : d;
    });
    this.changed.fire();
  }

  /**
   * The agent's run is over: its reply goes to the end of the ticket (after any comment written meanwhile), and says
   * whether the ticket is ready; a comment that came meanwhile goes on.
   */
  private async finished(id: string, agent: string, result: AgentResult, run: AgentRun): Promise<void> {
    // Ended by the user (paused or stopped): there's no reply to give.
    if (this.runs.get(id) !== run) return;
    this.runs.delete(id);
    try {
      const item = (await this.deps.backlog.read()).items.find((i) => i.id === id);
      if (!item) return;
      const reply = result.reply?.trim();
      if (result.limit) {
        await this.say(item, `${agent} stopped on a limit (${result.limit.kind}). Press Discuss to go on in a chat.`);
      } else if (result.error) {
        await this.say(item, `${agent} stopped without a reply (${result.error.slice(0, 200)}). Press Discuss to go on in a chat.`);
      } else if (!reply) {
        await this.say(item, `${agent} stopped without a reply. Press Discuss to go on in a chat.`);
      } else {
        await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: `Agent ${agent}`, body: reply });
        const ready = readyToStart((await this.deps.backlog.readTicket(item)).activity, agent);
        await this.deps.backlog.change((d) => {
          const shaping = d.items.find((i) => i.id === id)?.shaping;
          return shaping ? updateItem(d, id, { shaping: { ...shaping, ready: ready || undefined } }) : d;
        });
      }
    } finally {
      this.changed.fire();
    }
    if (this.again.delete(id)) await this.reply(id);
  }

  /** A note from Flotilla in the ticket's activity. */
  private async say(item: Pick<BacklogItem, 'id' | 'title' | 'notes'>, body: string): Promise<void> {
    await this.deps.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body });
  }

  /** The names of agents in the repository's chats: a new agent's name is none of them. */
  private takenNames(): string[] {
    return this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean);
  }
}
