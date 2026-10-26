import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentName } from '../../features/backlog/backlog';
import { INBOX } from '../../features/backlog/inbox';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  addedTo,
  askedForLimit,
  asksUser,
  becameText,
  nextNotes,
  type Note,
  noteChatOf,
  noteFollowUp,
  notePrompt,
  noteQuestion,
  noteReopenPrompt,
  type NoteState,
  type NoteStore,
  noteTools,
} from '../../features/backlog/notes';
import { retryDelay, type UsageLimit } from '../../features/backlog/limits';
import { transcriptPath } from '../../features/chats/chats';
import type { PausedAgent } from '../../features/backlog/pausedAll';
import type { Workstream } from '../../features/workstreams/workstream';
import type { NoteView, WebviewMessage } from '../../webview/protocol';
import { showError, type Commands } from '../commandSet';
import { closeNotePanel, openNotePanel } from './notePanel';
import { trackProgress } from '../progress';
import {
  agentChoice,
  type AgentResult,
  type AgentRun,
  memoryShortage,
  runAgentHeadless,
  validSession,
} from './agentRunner';

export interface NoteAgentsDeps {
  /** The extension's folder: the New Note tab's bundle is in its dist. */
  extensionUri: vscode.Uri;
  notes: NoteStore;
  backlog: LocalBacklog;
  repository: Repository<Workstream>;
  /** The main worktree: the agent reads the code there (it changes none of it). */
  mainRoot: string;
  output: vscode.OutputChannel;
  /** Only the leading window starts note agents. */
  isLeader(): boolean;
  /** A slot of the agents limit (ReviewLoop.admitNew), given back when the agent stops. */
  admit(id: string): number | undefined;
  giveBack(slot: number): void;
  /** While Pause All holds, no agent starts on its own. */
  pausedAll?(): boolean;
  /** Whether a note agent's chat is still there to go on in (its transcript, in the main worktree's chats). */
  chatExists?(session: string): boolean;
}

/** How long a finished agent's proposals may take to be taken in from the inbox, before the note records what it became. */
const INBOX_WAIT_MS = 20_000;
/** How long a draft left without its tab is kept. */
const DRAFT_KEPT_MS = 24 * 60 * 60_000;

/**
 * The note agents (BL-182): each open note, oldest first, is picked up by an agent without a window, within the agents
 * limit, whether the autopilot is on or not. Notes written in a row go to one agent together. The agent reads the
 * notes, the backlog and the code, asks in the note when it must (your answer resumes its chat), and proposes tickets
 * through the inbox; the note then records what it became.
 */
export class NoteAgents implements vscode.Disposable {
  /** The agents running, by the note that leads: its notes and its run. */
  private readonly runs = new Map<string, { ids: string[]; agent: string; run: AgentRun; started: string; paused?: boolean; deleted?: boolean }>();
  private ticking = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: NoteAgentsDeps) {
    const watch = deps.notes.watch(() => {
      // Deleted in another window (BL-215): its agent here stops.
      for (const [lead, r] of this.runs) if (!r.deleted && !deps.notes.exists(lead)) void this.stopRun(r);
      this.changed.fire();
      void this.tick();
    });
    // A row is picked up once it has settled, and a slot that comes free is taken: looked at every 5 s.
    const timer = setInterval(() => void this.tick(), 5000);
    // A note agent working in another window shows on its note here too.
    let working = '';
    const chats = deps.repository.onDidChange(() => {
      const now = [...this.chatAgents().keys()].sort().join(',');
      if (now !== working) this.changed.fire();
      working = now;
    });
    // A draft whose tab went with its window (a reload, a crash) is dropped a day later.
    void deps.notes.list().then(async (all) => {
      for (const n of all) if (n.status === 'draft' && Date.now() - Date.parse(n.created) > DRAFT_KEPT_MS) void deps.notes.drop(n.id);
      // Stopped on a limit before BL-203, they asked you instead of going on: open again, they go on in their chats.
      for (const n of all.filter(askedForLimit))
        for (const id of [n.id, ...(n.group ?? [])]) await deps.notes.setState(id, (s) => (s.status === 'asking' ? { ...s, status: 'open' } : s));
    });
    this.subscriptions.push({ dispose: () => (watch.dispose(), clearInterval(timer), chats.dispose()) }, this.changed);
  }

  /** The notes as the backlog's Notes lane shows them, oldest first. */
  async views(): Promise<NoteView[]> {
    const chats = this.chatAgents();
    // A draft is in its New Note tab until it's sent.
    return (await this.deps.notes.list())
      .filter((n) => n.status !== 'draft')
      .map((n) => {
        const agent = this.agentOf(n.id) ?? chats.get(n.with ?? n.id);
        const asks = noteQuestion(n);
        const waits = n.status === 'open' && !agent && n.limit && Date.parse(n.limit.until) > Date.now() ? n.limit : undefined;
        return {
          id: n.id,
          title: n.title,
          text: n.text,
          created: n.created,
          status: n.status === 'open' && agent ? 'working' : (n.status as Exclude<typeof n.status, 'draft'>),
          ...((agent ?? n.agent) ? { agent: agent ?? n.agent } : {}),
          ...(n.with ? { with: n.with } : {}),
          ...(asks ? { asks } : {}),
          ...(waits ? { waits: { until: waits.until, known: waits.known, kind: waits.kind } } : {}),
          became: n.became,
          ...(n.handled ? { handled: n.handled } : {}),
        };
      });
  }

  /** The Notes box's and cards' messages. */
  async onMessage(m: Extract<WebviewMessage, { type: 'note' }>): Promise<void> {
    switch (m.op) {
      case 'new':
        await this.newNote();
        return;
      case 'answer':
        await this.answer(m.id, m.text);
        return;
      case 'open':
        // Its note tab (BL-204): what you wrote, to edit, its activity, and a box to write in.
        await this.openNote(m.id);
        return;
      case 'delete':
        await this.deleteNote(m.id);
        return;
    }
  }

  /**
   * A card's × (BL-215): asks once, stops its agent (its slot given back), then deletes it with the notes handled with
   * it; their tabs close. The tickets it became stay.
   */
  async deleteNote(id: string): Promise<void> {
    const ids = await this.deps.notes.groupOf(id);
    if (!ids.length) return;
    const [lead, ...rest] = ids;
    const what = rest.length ? `${lead} and ${rest.join(', ')}, handled with it` : lead;
    const ok = await vscode.window.showWarningMessage(`Delete ${what}? Its agent stops; the tickets it became stay.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await Promise.all([...this.runs.values()].filter((r) => r.ids.some((i) => ids.includes(i))).map((r) => this.stopRun(r)));
    await this.deps.notes.delete(lead);
    ids.forEach(closeNotePanel);
    this.changed.fire();
    void this.tick();
  }

  /** Stops a run whose note is deleted; it ends as a paused one does (its slot given back, nothing written). */
  private async stopRun(r: { run: AgentRun; deleted?: boolean }): Promise<void> {
    r.deleted = true;
    r.run.stop();
    await r.run.done;
  }

  /** Flotilla: New Note (and the backlog's New Note button): the New Note tab, a draft until you send it. */
  async newNote(): Promise<void> {
    await openNotePanel(await this.panelDeps());
    this.changed.fire();
  }

  /** A sent note's tab (BL-204), where you edit it and write in it whatever its state. */
  async openNote(id: string): Promise<void> {
    await openNotePanel(await this.panelDeps(), id);
  }

  private async panelDeps(): Promise<Parameters<typeof openNotePanel>[0]> {
    const ids = await this.deps.backlog
      .read()
      .then((d) => d.items.map((i) => i.id))
      .catch(() => [] as string[]);
    return {
      extensionUri: this.deps.extensionUri,
      notes: this.deps.notes,
      mention: /^(.*?-)\d+$/.exec(ids[0] ?? '')?.[1] ?? '',
      sent: () => (this.changed.fire(), void this.tick()),
      dropped: () => this.changed.fire(),
      status: (id) => this.status(id),
      open: (id) => void this.openNote(id).catch(showError),
    };
  }

  /** A note's status as its card says it (working while an agent has it). */
  private async status(id: string): Promise<Pick<NoteView, 'status' | 'agent'> | undefined> {
    return (await this.views()).find((v) => v.id === id);
  }

  /** The note agents working in any window's chats, by the note they lead. */
  private chatAgents(): Map<string, string> {
    const found = new Map<string, string>();
    for (const w of this.deps.repository.current)
      for (const c of w.chats) {
        const note = noteChatOf(c.firstPrompt);
        if (note && c.state === 'working') found.set(note.note, note.agent);
      }
    return found;
  }

  dispose(): void {
    this.runs.forEach((r) => r.run.stop());
    this.subscriptions.forEach((s) => s.dispose());
  }

  /** The agent handling a note now (in this window), if one is. */
  agentOf(id: string): string | undefined {
    for (const r of this.runs.values()) if (r.ids.includes(id)) return r.agent;
    return undefined;
  }

  /** The user answered a note's question (or wrote in it, BL-204): it goes into the note, and its agent's chat goes on with it. */
  async answer(id: string, text: string): Promise<void> {
    if (!(await this.deps.notes.comment(id, text))) return;
    this.changed.fire();
    void this.tick();
  }

  /** Claude takes work again (ReviewLoop found the limit lifted, or Try Again Now did): the notes waiting on it go on. */
  async limitLifted(): Promise<void> {
    const now = new Date().toISOString();
    for (const n of await this.deps.notes.list())
      if (n.status === 'open' && n.limit && n.limit.until > now)
        await this.deps.notes.setState(n.id, (s) => (s.limit ? { ...s, limit: { ...s.limit, until: now } } : s));
    this.changed.fire();
    await this.tick();
  }

  /**
   * Pause All (BL-193): stops the agents running, once they've stopped; their notes stay open with their sessions, so
   * they resume in their chats once the hold is lifted. The paused, by the note that leads.
   */
  async pauseForAll(): Promise<PausedAgent[]> {
    const paused = [...this.runs].filter(([, r]) => !r.paused && !r.deleted);
    for (const [, r] of paused) {
      r.paused = true;
      r.run.stop();
    }
    await Promise.all(paused.map(([, r]) => r.run.done));
    return paused.map(([id, r]) => ({ id, kind: 'note', session: r.run.sessionId }));
  }

  /** Resume All: whether the note's agent goes on (its note still open in that chat); it does once the hold's lifted. */
  async resumeForAll(id: string, session?: string): Promise<'running' | undefined> {
    const note = await this.deps.notes.read(id);
    return note?.status === 'open' && note.session === session ? 'running' : undefined;
  }

  /** Starts agents for the notes that are due, while slots are free. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.isLeader()) return;
    // Paused in another window too: the agents running here stop.
    if (this.deps.pausedAll?.()) return void this.pauseForAll();
    this.ticking = true;
    try {
      for (;;) {
        const busy = new Set([...this.runs.values()].flatMap((r) => r.ids));
        const due = nextNotes(await this.deps.notes.list(), busy, Date.now());
        if (!due || memoryShortage()) return;
        const slot = this.deps.admit(`note:${due[0].id}`);
        if (slot === undefined) return;
        try {
          await this.start(due, slot);
        } catch (e) {
          this.deps.giveBack(slot);
          this.deps.output.appendLine(`Note agent for ${due[0].id}: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async start(notes: Note[], slot: number): Promise<void> {
    const [lead, ...rest] = notes;
    const agent = lead.agent ?? agentName(this.takenNames());
    // Reopened (BL-204): its chat goes on if it's still there, else a new one is told what the note became.
    const session = validSession(lead.session);
    const resume = session && (!lead.reopened || this.chatExists(session)) ? session : undefined;
    const files = notes.map((n) => ({ id: n.id, title: n.title, file: this.deps.notes.file(n.id) }));
    const o = { agent, notes: files, backlogDir: this.deps.backlog.dir, became: lead.became };
    const started = new Date().toISOString();
    const run = runAgentHeadless({
      cwd: this.deps.mainRoot,
      // Resumed after Pause All, unless the user's answer (or change) is the last word.
      prompt: resume
        ? noteFollowUp(o, lead.reopened ? 'reopened' : lead.changed || lead.activity.at(-1)?.author === 'You' ? 'answered' : 'paused')
        : lead.reopened
          ? noteReopenPrompt(o)
          : notePrompt(o),
      resume,
      name: `${agent} · handling ${lead.id}`,
      track: { ticket: lead.id, agent, role: 'note' },
      choice: agentChoice(undefined),
      output: this.deps.output,
      slot,
      tools: noteTools(this.deps.backlog.dir),
      offer: ['Write'],
    });
    const ids = notes.map((n) => n.id);
    this.runs.set(lead.id, { ids, agent, run, started });
    // What it's told now is taken in: a change after this goes on in its chat when it ends its turn.
    const taken = (s: NoteState): NoteState => ({ ...s, changed: s.changed && s.changed > started ? s.changed : undefined, reopened: undefined });
    try {
      await this.deps.notes.setState(lead.id, (s) => ({
        ...taken(s),
        agent,
        session: run.sessionId,
        ...(rest.length ? { group: rest.map((n) => n.id) } : {}),
      }));
      for (const n of rest) await this.deps.notes.setState(n.id, (s) => ({ ...s, agent, with: lead.id }));
    } catch (e) {
      this.runs.delete(lead.id);
      run.stop();
      throw e;
    }
    this.changed.fire();
    void trackProgress('backlog', `${agent} is handling ${lead.id}`, () => run.done);
    void run.done.then((result) =>
      this.finished(lead.id, ids, agent, result, slot).catch((e: unknown) =>
        this.deps.output.appendLine(`Note ${lead.id}: ${e instanceof Error ? e.message : String(e)}`),
      ),
    );
  }

  /**
   * The agent stopped: its reply goes into the lead note. A question waits for the user; otherwise the notes are
   * handled, once the inbox has taken in its proposals, and record what they became.
   */
  private async finished(lead: string, ids: string[], agent: string, result: AgentResult, slot: number): Promise<void> {
    this.deps.giveBack(slot);
    const started = this.runs.get(lead)?.started ?? '';
    // Paused (Pause All): its notes stay open, with their session, as they are. Deleted (BL-215): they're gone.
    if (this.runs.get(lead)?.paused || this.runs.get(lead)?.deleted) {
      this.runs.delete(lead);
      this.changed.fire();
      return;
    }
    // Its notes stay taken (in runs) until their state says what's next: open meanwhile, a tick would resume them.
    try {
      const reply = result.reply?.trim();
      // Stopped on a limit, it waits for it as a ticket's agent does, and goes on in its chat (BL-203).
      if (!reply && result.limit) return void (await this.waitForLimit(lead, agent, result.limit));
      await this.deps.notes.setState(lead, (s) => (s.limit ? { ...s, limit: undefined } : s));
      // You wrote in it while it worked (BL-204): its chat goes on with that, before it asks or is handled.
      const changed = (await this.deps.notes.read(lead))?.changed;
      if (changed && changed > started) {
        if (reply) await this.deps.notes.append(lead, { author: `Agent ${agent}`, body: reply });
        for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'open' }));
        return;
      }
      if (!reply) {
        const why = result.error ? `without a reply (${result.error.slice(0, 200)})` : 'without a reply';
        await this.deps.notes.append(lead, { author: 'Flotilla', body: `${agent} stopped ${why}. Answer here and it goes on.` });
        for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'asking' }));
        return;
      }
      await this.deps.notes.append(lead, { author: `Agent ${agent}`, body: reply });
      if (asksUser(reply)) {
        for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'asking' }));
        return;
      }
      const added = addedTo(
        reply,
        (await this.deps.backlog.read()).items.map((i) => i.id),
      );
      // A proposal it became and updated since (reopened, BL-204) stays a proposal.
      const proposed = new Set(((await this.deps.notes.read(lead))?.became ?? []).filter((b) => b.kind === 'proposal').map((b) => b.id));
      for (const id of added.filter((a) => !proposed.has(a))) await this.deps.notes.recordBecame(ids, { id, kind: 'added' });
      await this.inboxTaken();
      const became = (await this.deps.notes.read(lead))?.became ?? [];
      const handled = new Date().toISOString();
      for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'handled', handled, changed: undefined, reopened: undefined }));
      await this.deps.notes.append(lead, { author: 'Flotilla', body: `${becameText(became, (id) => `[${id}](../${id}.md)`)}.` });
    } finally {
      this.runs.delete(lead);
      this.changed.fire();
      void this.tick();
    }
  }

  /**
   * The lead note's agent stopped on a limit: its notes stay open, with its session, until it lifts. A guessed-at reset
   * hit again waits longer each time (see retryDelay); the note says so the first time.
   */
  private async waitForLimit(lead: string, agent: string, limit: UsageLimit): Promise<void> {
    const before = (await this.deps.notes.read(lead))?.limit;
    const again = before && !limit.known ? { tries: (before.tries ?? 0) + 1, since: before.since ?? new Date().toISOString() } : undefined;
    const until = again ? new Date(Date.now() + retryDelay(limit.kind, again.tries, Date.now() - Date.parse(again.since))) : limit.until;
    await this.deps.notes.setState(lead, (s) => ({
      ...s,
      limit: {
        until: until.toISOString(),
        known: limit.known,
        kind: limit.kind,
        ...(limit.known ? {} : { tries: again?.tries ?? 0, since: again?.since ?? new Date().toISOString() }),
      },
    }));
    if (before) return;
    const what = limit.kind === 'usage' ? "Claude's usage limit" : limit.kind === 'rate' ? "Claude's rate limit" : 'Claude being overloaded';
    const when = until.toLocaleString();
    await this.deps.notes.append(lead, {
      author: 'Flotilla',
      body: `${agent} stopped on ${what}. It goes on by itself ${limit.known ? `when it resets (${when})` : `at ${when}, and tries again after that if it must`}.`,
    });
  }

  /** Waits (a while at most) until the inbox has taken in what's in it. */
  private async inboxTaken(): Promise<void> {
    const dir = path.join(this.deps.backlog.dir, INBOX);
    const deadline = Date.now() + INBOX_WAIT_MS;
    while (Date.now() < deadline) {
      const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
      if (!names.some((n) => (n.endsWith('.md') && !n.startsWith('.')) || n.endsWith('.taking'))) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private chatExists(session: string): boolean {
    if (this.deps.chatExists) return this.deps.chatExists(session);
    try {
      return fs.existsSync(transcriptPath(this.deps.mainRoot, session));
    } catch {
      return false;
    }
  }

  /** The names of agents in the repository's chats: a new agent's name is none of them. */
  private takenNames(): string[] {
    return [
      ...this.deps.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean),
      ...[...this.runs.values()].map((r) => r.agent),
    ];
  }
}

/** The notes' commands: Flotilla: New Note. */
export function noteCommands(notes: NoteAgents): Commands {
  return { 'flotilla.newNote': () => notes.newNote().catch(showError) };
}
