import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentName, updateItem, type BacklogItem } from '../../features/backlog/backlog';
import { discussable, followUpPrompt, readyToStart, shapingPrompt, shapingTools } from '../../features/backlog/shaping';
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
}

/**
 * Discussions of tickets nobody works on yet (BL-45). A comment by the user starts the ticket's shaping agent, or
 * resumes its chat; so does Discuss, without a comment. The agent talks in the ticket and writes what's agreed into
 * its description; it may edit nothing else (see shapingTools). A comment that comes while it runs is answered when it
 * stops.
 */
export class Shaping implements vscode.Disposable {
  private readonly runs = new Map<string, AgentRun>();
  /** Tickets whose agent is being started: claimed before the first await, so a second call can't start another. */
  private readonly starting = new Set<string>();
  /** Tickets with a comment that came while their agent was running: answered when it stops. */
  private readonly again = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private readonly watcher: vscode.Disposable;

  constructor(private readonly deps: ShapingDeps) {
    // A discussion the user paused or stopped in another window ends here, if it runs here.
    this.watcher = deps.backlog.watch(() => void this.endHeld().catch(() => undefined));
  }

  dispose(): void {
    this.watcher.dispose();
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
      if (shaping.held) await this.discuss(id, true);
      return;
    }
    await this.deps.backlog.change((d) => updateItem(d, id, { shaping: { ...shaping, held: { kind: action === 'pause' ? 'paused' : 'stopped', at: new Date().toISOString() } } }));
    await this.endHeld();
    await this.say(
      item,
      action === 'pause'
        ? `You paused ${shaping.agent}. Its chat is kept: Resume, or write a comment, and it goes on there.`
        : `You stopped ${shaping.agent}. Resume, or write a comment, and it goes on in its chat.`,
    );
    this.changed.fire();
  }

  /** Whether an agent is discussing the ticket now (in this window). */
  isRunning(id: string): boolean {
    return this.runs.has(id) || this.starting.has(id);
  }

  /**
   * Starts the ticket's discussion, or goes on with it: its agent answers what the user wrote (opened: without a
   * comment yet, from Discuss). Nothing happens to a ticket that's being worked on.
   */
  async discuss(id: string, opened = false): Promise<void> {
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
      if (!item.shaping) {
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
        await this.say(item, `${agent} stopped on a limit (${result.limit.kind}). Write a comment, or press Discuss, to go on.`);
      } else if (result.error) {
        await this.say(item, `${agent} stopped without a reply (${result.error.slice(0, 200)}). Write a comment, or press Discuss, to go on.`);
      } else if (!reply) {
        await this.say(item, `${agent} stopped without a reply. Write a comment, or press Discuss, to go on.`);
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
    if (this.again.delete(id)) await this.discuss(id);
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
