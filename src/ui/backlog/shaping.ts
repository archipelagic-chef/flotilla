import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentName, updateItem, type BacklogItem } from '../../features/backlog/backlog';
import type { Chat } from '../../features/chats/chats';
import {
  discussable,
  discussionPrompt,
  findDiscussionChat,
  followUpPrompt,
  readyToStart,
  shapingPrompt,
  shapingTools,
  summarizedSince,
  CHAT_LINK,
} from '../../features/backlog/shaping';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import { entryDate } from '../../features/backlog/ticket';
import type { Workstream } from '../../features/workstreams/workstream';
import { trackProgress } from '../progress';
import { agentChoice, runAgentHeadless, validSession, type AgentResult, type AgentRun } from './agentRunner';

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
}

/** A ticket's discussion chat, and the worktree it's listed in. */
export interface DiscussionChat {
  key: string;
  chat: Chat;
}

/**
 * Discussions of tickets nobody works on yet. Discuss opens a Claude Code chat with the ticket's discussion agent
 * (BL-188): the user talks with it there, it writes what's agreed into the description and a summary into the activity
 * when they're done; Discuss again opens that chat. The ticket says "Discussing" while it's open, and notes a chat
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
    this.changed.dispose();
  }

  /** The session of the ticket's shaping agent if it runs in this window. */
  runningSession(id: string): string | undefined {
    return this.runs.get(id)?.sessionId;
  }

  /** Ends the runs here of discussions the user paused or stopped. */
  private async endHeld(): Promise<void> {
    if (!this.runs.size) return;
    for (const item of (await this.deps.backlog.read()).items) {
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
      if (shaping.held) await this.reply(id, true);
      return;
    }
    await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { ...shaping, held: { kind: action === 'pause' ? 'paused' : 'stopped', at: new Date().toISOString() } } }));
    await this.endHeld();
    await this.say(
      item,
      action === 'pause'
        ? `You paused ${shaping.agent}. Its chat is kept: Resume, and it goes on there.`
        : `You stopped ${shaping.agent}. Resume, and it goes on in its chat.`,
    );
    this.changed.fire();
  }

  /** Whether an agent is replying in the ticket now (in this window; a discussion chat isn't, see chatOf). */
  isRunning(id: string): boolean {
    return this.runs.has(id) || this.starting.has(id);
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
   * Discuss (BL-188): opens the ticket's discussion chat, or a new one with its first message filled in (the agent
   * opens the conversation once it's sent). Nothing happens to a ticket that's being worked on.
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
      // A reply running in the ticket (the older way) gives way to the chat.
      const run = this.runs.get(id);
      if (run) {
        this.runs.delete(id);
        run.stop();
      }
      const agent = shaping?.agent ?? agentName(this.takenNames());
      const ticket = await this.deps.backlog.ensureDocument(item);
      const [lead, ...task] = discussionPrompt({ item, agent, ticket }).split('\n\n');
      // A chat opened before whose first message wasn't sent keeps its start: its summary is looked for from then.
      const since = (!shaping?.session && shaping?.chat?.since) || entryDate(new Date());
      await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { agent, session: '', chat: { since } } }));
      if (!shaping?.chat) {
        await this.say(
          item,
          `Opened a chat for agent ${agent} to discuss this ticket with you: send its first message, and it starts with what it understood and its questions. It writes what's agreed into the description as you go, and a summary here when you're done.`,
        );
      }
      this.watch(id, false);
      await this.deps.newChat(lead, task.join('\n\n'));
    } finally {
      this.opening.delete(id);
      this.changed.fire();
    }
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
        await this.say(item, `${shaping.agent}'s chat closed without a summary of the discussion. [Open its chat](${CHAT_LINK}${found.chat.id}) to go on, or press Discuss.`);
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
    if (item.shaping?.chat) item.shaping = undefined;
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
        await this.say(item, `Opened a chat for agent ${agent} to discuss this ticket with you. It replies here, and writes what's agreed into the description.`);
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
