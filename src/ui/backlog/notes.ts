import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { agentChatItem, agentName } from '../../features/backlog/backlog';
import { INBOX } from '../../features/backlog/inbox';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  addedTo,
  asksUser,
  becameText,
  nextNotes,
  noteFollowUp,
  noteChatOf,
  noteQuestion,
  notePrompt,
  noteTools,
  type Note,
  type NoteStore,
} from '../../features/backlog/notes';
import type { Workstream } from '../../features/workstreams/workstream';
import type { NoteView, WebviewMessage } from '../../webview/protocol';
import { showError, type Commands } from '../commandSet';
import { trackProgress } from '../progress';
import { agentChoice, memoryShortage, runAgentHeadless, validSession, type AgentResult, type AgentRun } from './agentRunner';

export interface NoteAgentsDeps {
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
}

/** How long a finished agent's proposals may take to be taken in from the inbox, before the note records what it became. */
const INBOX_WAIT_MS = 20_000;

/**
 * The note agents (BL-182): each open note, oldest first, is picked up by an agent without a window, within the agents
 * limit, whether the autopilot is on or not. Notes written in a row go to one agent together. The agent reads the
 * notes, the backlog and the code, asks in the note when it must (your answer resumes its chat), and proposes tickets
 * through the inbox; the note then records what it became.
 */
export class NoteAgents implements vscode.Disposable {
  /** The agents running, by the note that leads: its notes and its run. */
  private readonly runs = new Map<string, { ids: string[]; agent: string; run: AgentRun }>();
  private ticking = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: NoteAgentsDeps) {
    const watch = deps.notes.watch(() => {
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
    this.subscriptions.push({ dispose: () => (watch.dispose(), clearInterval(timer), chats.dispose()) }, this.changed);
  }

  /** The notes as the backlog's Notes lane shows them, oldest first. */
  async views(): Promise<NoteView[]> {
    const chats = this.chatAgents();
    return (await this.deps.notes.list()).map((n) => {
      const agent = this.agentOf(n.id) ?? chats.get(n.with ?? n.id);
      const asks = noteQuestion(n);
      return {
        id: n.id,
        title: n.title,
        text: n.text,
        created: n.created,
        status: n.status === 'open' && agent ? 'working' : n.status,
        ...(agent ?? n.agent ? { agent: agent ?? n.agent } : {}),
        ...(n.with ? { with: n.with } : {}),
        ...(asks ? { asks } : {}),
        became: n.became,
        ...(n.handled ? { handled: n.handled } : {}),
      };
    });
  }

  /** The Notes box's and cards' messages. */
  async onMessage(m: Extract<WebviewMessage, { type: 'note' }>): Promise<void> {
    switch (m.op) {
      case 'add':
        await this.add(m.text, (m.images ?? []).map((i) => ({ name: i.name, bytes: Buffer.from(i.data, 'base64') })));
        return;
      case 'answer':
        await this.answer(m.id, m.text);
        return;
      case 'open':
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(this.deps.notes.file(m.id)));
        return;
    }
  }

  /** Flotilla: New Note: asks for the note in an input box. */
  async newNote(): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: 'New Note',
      prompt: 'An agent turns it into ticket proposals, asking you here when it must.',
      placeHolder: 'Jot down an idea, a bug, a wish…',
      ignoreFocusOut: true,
    });
    const note = text?.trim() ? await this.add(text) : undefined;
    if (note) void vscode.window.showInformationMessage(`${note.id} is in the backlog's Notes: an agent picks it up in a moment.`);
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

  /** Adds a note; an agent picks it up once it has settled (a note sent right after it goes with it). */
  async add(text: string, images: ReadonlyArray<{ name: string; bytes: Uint8Array }> = []): Promise<Note | undefined> {
    if (!text.trim() && !images.length) return undefined;
    const note = await this.deps.notes.add(text, images);
    this.changed.fire();
    return note;
  }

  /** The user answered a note's question: their answer goes into the note, and its agent's chat goes on with it. */
  async answer(id: string, text: string): Promise<void> {
    const note = await this.deps.notes.read(id);
    if (!note || !text.trim()) return;
    const lead = note.with ?? note.id;
    await this.deps.notes.append(lead, { author: 'You', body: text.trim() });
    const group = (await this.deps.notes.read(lead))?.group ?? [];
    for (const n of [lead, ...group]) await this.deps.notes.setState(n, (s) => (s.status === 'handled' ? s : { ...s, status: 'open' }));
    this.changed.fire();
    void this.tick();
  }

  /** Starts agents for the notes that are due, while slots are free. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.isLeader() || this.deps.pausedAll?.()) return;
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
    const resume = validSession(lead.session);
    const files = notes.map((n) => ({ id: n.id, title: n.title, file: this.deps.notes.file(n.id) }));
    const o = { agent, notes: files, backlogDir: this.deps.backlog.dir };
    const run = runAgentHeadless({
      cwd: this.deps.mainRoot,
      prompt: resume ? noteFollowUp(o) : notePrompt(o),
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
    this.runs.set(lead.id, { ids, agent, run });
    try {
      await this.deps.notes.setState(lead.id, (s) => ({ ...s, agent, session: run.sessionId, ...(rest.length ? { group: rest.map((n) => n.id) } : {}) }));
      for (const n of rest) await this.deps.notes.setState(n.id, (s) => ({ ...s, agent, with: lead.id }));
    } catch (e) {
      this.runs.delete(lead.id);
      run.stop();
      throw e;
    }
    this.changed.fire();
    void trackProgress('backlog', `${agent} is handling ${lead.id}`, () => run.done);
    void run.done.then((result) => this.finished(lead.id, ids, agent, result, slot).catch((e: unknown) => this.deps.output.appendLine(`Note ${lead.id}: ${e instanceof Error ? e.message : String(e)}`)));
  }

  /**
   * The agent stopped: its reply goes into the lead note. A question waits for the user; otherwise the notes are
   * handled, once the inbox has taken in its proposals, and record what they became.
   */
  private async finished(lead: string, ids: string[], agent: string, result: AgentResult, slot: number): Promise<void> {
    this.deps.giveBack(slot);
    // Its notes stay taken (in runs) until their state says what's next: open meanwhile, a tick would resume them.
    try {
      const reply = result.reply?.trim();
      if (!reply) {
        const why = result.limit ? `on a limit (${result.limit.kind})` : result.error ? `without a reply (${result.error.slice(0, 200)})` : 'without a reply';
        await this.deps.notes.append(lead, { author: 'Flotilla', body: `${agent} stopped ${why}. Answer here and it goes on.` });
        for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'asking' }));
        return;
      }
      await this.deps.notes.append(lead, { author: `Agent ${agent}`, body: reply });
      if (asksUser(reply)) {
        for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'asking' }));
        return;
      }
      const added = addedTo(reply, (await this.deps.backlog.read()).items.map((i) => i.id));
      for (const id of added) await this.deps.notes.recordBecame(ids, { id, kind: 'added' });
      await this.inboxTaken();
      const became = (await this.deps.notes.read(lead))?.became ?? [];
      const handled = new Date().toISOString();
      for (const id of ids) await this.deps.notes.setState(id, (s) => ({ ...s, status: 'handled', handled }));
      await this.deps.notes.append(lead, { author: 'Flotilla', body: `${becameText(became, (id) => `[${id}](../${id}.md)`)}.` });
    } finally {
      this.runs.delete(lead);
      this.changed.fire();
      void this.tick();
    }
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
