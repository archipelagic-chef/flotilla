import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { AskChat } from '../../features/backlog/askChat';
import { discussionTurns } from '../../features/backlog/discussChat';
import { agentName } from '../../features/backlog/backlog';
import {
  asksForTickets,
  DISCUSSION_ALLOWED,
  DISCUSSION_DENIED,
  type DiscussionStore,
  freeDiscussionPrompt,
  PROPOSE_OFFER,
  PROPOSE_TICKETS,
  proposeDiscussionPrompt,
  proposeTools,
} from '../../features/backlog/discussions';
import type { PausedAgent } from '../../features/backlog/pausedAll';
import { transcriptPath } from '../../features/chats/chats';
import { formatMemory } from '../../features/workstreams/memory';
import type {
  DiscussionHostMessage,
  DiscussionTabView,
  DiscussionWebviewMessage,
} from '../../webview/discussionProtocol';
import type { DiscussionRowView } from '../../webview/protocol';
import {
  type Commands,
  showError,
} from '../commandSet';
import { openLink } from '../metrics/reviewPanel';
import {
  agentChoice,
  memoryShortage,
  spawnDiscussion,
} from './agentRunner';
import { renderMarkdown } from './ticketPanel';

export interface DiscussionsDeps {
  extensionUri: vscode.Uri;
  store: DiscussionStore;
  /** The main worktree: the agent reads the code there (it changes none of it). */
  mainRoot: string;
  /** Where links to files open. */
  reference: vscode.Uri;
  output: vscode.OutputChannel;
  /** Where Claude Code keeps chats' transcripts (tests: a folder of their own). */
  claudeHome?: string;
  /** Opens a ticket's tab (a ticket a discussion became). */
  openTicket(id: string): void;
}

/** A discussion's open tab: its chat, its process up while it talks. */
interface Tab {
  panel: vscode.WebviewPanel;
  chat: AskChat;
  paused: boolean;
  /** Its agent proposes tickets this turn (BL-268), as this agent: its process may write into the inbox, then ends. */
  proposing?: string;
  /** Shows the tab again, as its file now says. */
  refresh?(): void;
}

/**
 * Discussions (BL-267): an idea talked through with an agent, with no ticket expected. New Discussion opens a tab with
 * a chat (the Discuss pane's, BL-241) whose agent reads the code and the backlog and changes nothing; its session is
 * kept, so opening it again (even after a reload) shows the chat and goes on with it. Its process is up while its tab
 * is open, outside flotilla.agents.maxRunning, as a ticket's Discuss is.
 */
export class Discussions implements vscode.Disposable {
  private readonly tabs = new Map<string, Tab>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly deps: DiscussionsDeps) {
    // A discussion's file changes in any window (a ticket proposed from it, BL-268; a rename): its row and tab show it.
    // It's written by renaming a new file onto it, which some platforms report as a create: any event will do.
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(deps.store.dir), 'DISC-*.md'));
    const changed = () => {
      this.changed.fire();
      for (const tab of this.tabs.values()) tab.refresh?.();
    };
    this.watcher.onDidChange(changed);
    this.watcher.onDidCreate(changed);
    this.watcher.onDidDelete(changed);
  }

  dispose(): void {
    for (const t of this.tabs.values()) t.panel.dispose();
    this.watcher.dispose();
    this.changed.dispose();
  }

  /** The sidebar's Discussions section: those talked in, newest first. */
  async views(): Promise<DiscussionRowView[]> {
    return (await this.deps.store.list()).map((d) => ({ id: d.id, title: d.title, talked: d.talked!, ...(d.became ? { became: d.became } : {}) }));
  }

  /** The sidebar's messages. */
  async onMessage(m: { op: 'new' } | { op: 'open' | 'rename' | 'delete'; id: string }): Promise<void> {
    if (m.op === 'new') await this.open();
    else if (m.op === 'open') await this.open(m.id);
    else if (m.op === 'rename') await this.rename(m.id);
    else await this.delete(m.id);
  }

  /** Opens a discussion's tab (a new one's without an id): shown again when it's open. */
  async open(id?: string): Promise<void> {
    const shown = id && this.tabs.get(id);
    if (shown) return shown.panel.reveal();
    const d = id ? await this.deps.store.read(id) : await this.deps.store.create();
    if (!d) {
      void vscode.window.showWarningMessage(`${id} isn't there anymore.`);
      return;
    }
    const { store, mainRoot } = this.deps;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('flotilla.discussion', d.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist, vscode.Uri.file(mainRoot)],
    });
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'flotilla.svg');
    panel.webview.html = html(panel.webview, dist);
    const transcript = () => transcriptPath(mainRoot, d.session, this.deps.claudeHome);
    const render = (markdown: string) => renderMarkdown(markdown, panel.webview, mainRoot, [mainRoot]);
    const post = (m: DiscussionHostMessage) => void panel.webview.postMessage(m);
    const choice = agentChoice(undefined);
    const chat: AskChat = new AskChat({
      model: choice.model ?? 'claude',
      kept: true,
      starting: 'Reading the code and the backlog…',
      memoryShort: () => {
        const short = memoryShortage();
        return short && `Waiting for memory: ${formatMemory(short.freeMB)} free, and flotilla.agents.minFreeMemoryMB asks for ${formatMemory(short.minMB)}…`;
      },
      context: async () => ({ cwd: mainRoot, text: '' }),
      spawn: (cwd) =>
        spawnDiscussion(cwd, {
          // Asked for tickets (BL-268): this turn's process may write into the inbox; otherwise it changes nothing.
          ...(tab.proposing
            ? {
                instructions: proposeDiscussionPrompt({ id: d.id, agent: tab.proposing, backlogDir: store.backlogDir }),
                tools: proposeTools(store.backlogDir),
                offer: PROPOSE_OFFER,
              }
            : { instructions: freeDiscussionPrompt({ backlogDir: store.backlogDir }), tools: DISCUSSION_ALLOWED }),
          session: d.session,
          // Resumed once its session has a transcript (its first message was taken).
          resume: fs.existsSync(transcript()),
          denied: DISCUSSION_DENIED,
          choice,
          output: this.deps.output,
          ticket: d.id,
          agent: tab.proposing ?? 'Discussion',
        }),
      render,
      changed: () => void view().then((v) => v && post({ type: 'discussion', view: v })),
      log: (line) => this.deps.output.appendLine(line),
      // The proposing turn is over: its process ends, so the next message's is read-only again.
      answered: () => {
        if (!tab.proposing) return;
        tab.proposing = undefined;
        chat.halt();
      },
    });
    const tab: Tab = { panel, chat, paused: false, refresh: () => void view().then((v) => v && post({ type: 'discussion', view: v })) };
    this.tabs.set(d.id, tab);
    const view = async (): Promise<DiscussionTabView | undefined> => {
      if (this.tabs.get(d.id) !== tab) return undefined;
      const now = await store.read(d.id);
      return {
        id: d.id,
        title: now?.title ?? d.title,
        chat: chat.view(),
        ...(tab.paused ? { paused: true as const } : {}),
        ...(now?.became ? { became: now.became } : {}),
        ...(tab.proposing ? { proposing: true as const } : {}),
      };
    };
    try {
      const turns = discussionTurns(await fs.promises.readFile(transcript(), 'utf8'), { opener: false });
      for (const t of turns) if (t.answer.trim()) t.html = await render(t.answer);
      chat.restore(turns);
    } catch {
      // Not talked in yet.
    }
    panel.webview.onDidReceiveMessage(async (m: DiscussionWebviewMessage) => {
      let failed = false;
      try {
        if (m.type === 'ready') {
          const v = await view();
          if (v) post({ type: 'discussion', view: v });
        } else if (m.type === 'discussSend') await this.send(d.id, m.text);
        else if (m.type === 'propose') await this.send(d.id, PROPOSE_TICKETS, { propose: true });
        else if (m.type === 'openTicket') this.deps.openTicket(m.id);
        else if (m.type === 'discussStop') chat.stop();
        else if (m.type === 'rename') await this.rename(d.id);
        else if (m.type === 'delete') await this.delete(d.id);
        else if (m.type === 'openHref') await openLink(this.deps.reference, m.href, [mainRoot, store.backlogDir]);
      } catch (e) {
        failed = true;
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      } finally {
        if (m.type !== 'ready' && m.type !== 'openHref') post({ type: 'done', message: m, ...(failed ? { failed } : {}) });
      }
    });
    panel.onDidDispose(() => {
      if (this.tabs.get(d.id) === tab) this.tabs.delete(d.id);
      chat.dispose();
      // Closed before anything was said: it isn't kept.
      void store.read(d.id).then((now) => (now && !now.talked ? store.delete(d.id) : undefined));
    });
  }

  /**
   * You write in a discussion: it was talked in now (its first message titles it), and the agent answers. Propose
   * Tickets, or a message asking for tickets, has it propose them (BL-268): that turn's process starts with the inbox's
   * tools, and ends with its answer.
   */
  private async send(id: string, text: string, o: { propose?: boolean } = {}): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab || !text.trim() || tab.chat.busy) return;
    tab.paused = false;
    if (o.propose || asksForTickets(text)) {
      // The read-only process ends; the next one (this turn's) resumes the session with the inbox's tools.
      if (tab.chat.live) tab.chat.halt();
      tab.proposing = agentName([]);
    }
    const d = await this.deps.store.talked(id, text);
    if (d) tab.panel.title = d.title;
    this.changed.fire();
    await tab.chat.ask(text);
  }

  /** Rename, from the section or the tab: asks for the new title. */
  private async rename(id: string): Promise<void> {
    const d = await this.deps.store.read(id);
    if (!d) return;
    const title = await vscode.window.showInputBox({
      title: `Rename ${id}`,
      value: d.title,
      validateInput: (v) => (v.trim() ? undefined : 'A title, please.'),
    });
    if (!title?.trim()) return;
    await this.deps.store.rename(id, title);
    const tab = this.tabs.get(id);
    if (tab) {
      tab.panel.title = title.trim();
      tab.refresh?.();
    }
    this.changed.fire();
  }

  /** Delete, from the section or the tab: asks first, then its tab closes and its file goes. */
  private async delete(id: string): Promise<void> {
    const d = await this.deps.store.read(id);
    if (!d) return;
    const choice = await vscode.window.showWarningMessage(`Delete the discussion "${d.title}"?`, { modal: true, detail: 'Its chat goes with it.' }, 'Delete');
    if (choice !== 'Delete') return;
    await this.deps.store.delete(id);
    this.tabs.get(id)?.panel.dispose();
    this.changed.fire();
  }

  /** Pause All: the discussions answering now stop, their chats kept; writing in one goes on with it. */
  pauseForAll(): PausedAgent[] {
    const paused: PausedAgent[] = [];
    for (const [id, tab] of this.tabs) {
      if (!tab.chat.live) continue;
      tab.chat.halt();
      tab.paused = true;
      paused.push({ id, kind: 'discussion' });
    }
    return paused;
  }

  /** Resume All: a discussion it paused says so no more (it goes on when you write, as a ticket's Discuss does). */
  resumeForAll(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab?.paused) return;
    tab.paused = false;
    tab.refresh?.();
  }
}

/** New Discussion (the backlog's title bar, and the command palette). */
export function discussionCommands(discussions: Discussions): Commands {
  return {
    'flotilla.newDiscussion': () => discussions.open().catch(showError),
    // A ticket's "From DISC-3" link (BL-268).
    'flotilla.openDiscussion': (id: unknown) => (typeof id === 'string' ? discussions.open(id).catch(showError) : undefined),
  };
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('discussion.css')}">
</head>
<body>
<div id="root" data-mermaid="${uri('mermaid.js')}"></div>
<script nonce="${nonce}" src="${uri('discussion.js')}"></script>
</body>
</html>`;
}
