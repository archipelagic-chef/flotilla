import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { branchMatches, updateItem, type BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { RemoteIssue } from '../../features/backlog/sources/source';
import type { BacklogIntegrations } from './integrations';
import { entryDate, type Ticket } from '../../features/backlog/ticket';
import type { Workstream } from '../../features/workstreams/workstream';
import type { TicketHostMessage, TicketView, TicketWebviewMessage } from '../../webview/ticketProtocol';
import { ATTENTION_LABEL, workstreamLabel } from '../format';

export interface TicketDeps {
  extensionUri: vscode.Uri;
  backlog: LocalBacklog;
  integrations: BacklogIntegrations;
  repository: Repository<Workstream>;
  /** Shows a worktree's tab in the sidebar. */
  revealWorktree(key: string): void;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Renders Markdown with VS Code's own renderer (the built-in Markdown extension); plain text if it's unavailable. */
async function renderMarkdown(text: string, webview: vscode.Webview, dir: string): Promise<string> {
  if (!text.trim()) return '';
  let html: string;
  try {
    html = await vscode.commands.executeCommand<string>('markdown.api.render', text);
  } catch {
    html = `<pre>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`;
  }
  // Images next to the tickets (BL-3/shot.png) load through the webview.
  // Task list items ("- [ ] …") as checkboxes, like GitHub shows them.
  html = html.replace(/(<li\b[^>]*>)\s*\[([ xX])\]\s+/g, (_m, li: string, mark: string) => `${li}<span class="task${mark === ' ' ? '' : ' checked'}"></span>`);
  return html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (m, a: string, src: string, c: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return m;
    const file = path.resolve(dir, decodeURIComponent(src));
    if (!file.startsWith(dir + path.sep)) return m;
    return `${a}${webview.asWebviewUri(vscode.Uri.file(file)).toString()}${c}`;
  });
}

/** Ticket editor tabs: one per backlog item, kept up to date with the ticket file and the item's worktree. */
export class TicketPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: TicketDeps) {
    this.subscriptions.push(
      { dispose: deps.repository.onDidChange(() => this.refreshAll()).dispose },
      deps.backlog.watch(() => this.refreshAll()),
      deps.integrations.onDidChange(() => this.refreshAll()),
    );
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.panels.forEach((p) => p.dispose());
  }

  async open(id: string): Promise<void> {
    const existing = this.panels.get(id);
    if (existing) {
      existing.reveal();
      return;
    }
    const item = await this.item(id);
    if (!item) return;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('flotilla.ticket', `${item.id} ${item.title}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist, vscode.Uri.file(this.deps.backlog.dir)],
    });
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'flotilla.svg');
    panel.webview.html = this.html(panel.webview, dist);
    this.panels.set(id, panel);
    panel.onDidDispose(() => this.panels.delete(id));
    panel.webview.onDidReceiveMessage((m: TicketWebviewMessage) =>
      this.onMessage(id, panel, m).catch((e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))),
    );
  }

  /** The worktrees working on an item: those started for it, or whose branch carries its id. */
  worktreesOf(item: BacklogItem): Workstream[] {
    return this.deps.repository.current.filter((w) => !w.worktree.isMain && w.worktree.branch && branchMatches(item, w.worktree.branch));
  }

  /** A local item, or an issue from an integration (as an item, with remote set). */
  private async item(id: string): Promise<(BacklogItem & { remote?: RemoteIssue }) | undefined> {
    const local = (await this.deps.backlog.read()).items.find((i) => i.id === id);
    if (local) return local;
    const remote = this.deps.integrations.issues().find((i) => i.id === id);
    return remote && { id, title: remote.title, status: remote.status, priority: remote.priority, created: '', remote };
  }

  /** An issue's description and comments from its tracker, with the local activity (agents' reports) merged in. */
  private async remoteView(item: BacklogItem & { remote: RemoteIssue }, webview: vscode.Webview): Promise<Pick<TicketView, 'description' | 'descriptionHtml' | 'activity' | 'error'>> {
    const dir = this.deps.backlog.dir;
    const local = (await this.deps.backlog.readTicket(item)).activity;
    const localEntries = await Promise.all(local.map(async (e) => ({ ...e, html: await renderMarkdown(e.body, webview, dir) })));
    try {
      const source = await this.deps.integrations.sourceOf(item.id);
      if (!source) throw new Error('Its integration is no longer connected.');
      const d = await source.details(item.id);
      const remoteEntries = await Promise.all(
        d.comments.map(async (c) => ({
          date: entryDate(new Date(c.date)),
          author: c.author,
          body: c.body,
          html: c.format === 'html' ? c.body : await renderMarkdown(c.body, webview, dir),
        })),
      );
      return {
        description: d.descriptionText,
        descriptionHtml: d.format === 'html' ? d.description : await renderMarkdown(d.description, webview, dir),
        activity: [...remoteEntries, ...localEntries].sort((a, b) => a.date.localeCompare(b.date)),
      };
    } catch (error) {
      return { description: '', descriptionHtml: '', activity: localEntries, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private refreshAll(): void {
    for (const [id, panel] of this.panels) void this.post(id, panel);
  }

  private async post(id: string, panel: vscode.WebviewPanel): Promise<void> {
    const item = await this.item(id);
    if (!item) {
      panel.dispose();
      return;
    }
    panel.title = `${item.id} ${item.title}`;
    const dir = this.deps.backlog.dir;
    const { remote, ...plain } = item;
    let content: Pick<TicketView, 'description' | 'descriptionHtml' | 'activity' | 'error'>;
    if (remote) {
      content = await this.remoteView({ ...plain, remote }, panel.webview);
    } else {
      const ticket = await this.deps.backlog.readTicket(item);
      content = {
        description: ticket.description,
        descriptionHtml: await renderMarkdown(ticket.description, panel.webview, dir),
        activity: await Promise.all(ticket.activity.map(async (e) => ({ ...e, html: await renderMarkdown(e.body, panel.webview, dir) }))),
      };
    }
    const source = remote && this.deps.integrations.current.find((s) => s.config.id === remote.source);
    const view: TicketView = {
      item: plain,
      ...content,
      remote: remote && source && { kind: source.config.kind, label: source.label, url: remote.url, statusName: remote.statusName },
      worktrees: this.worktreesOf(item).map((ws) => ({
        key: ws.key,
        branch: workstreamLabel(ws),
        attention: ws.attention,
        status: ATTENTION_LABEL[ws.attention],
        message: ws.agent?.message,
      })),
    };
    const message: TicketHostMessage = { type: 'ticket', ticket: view };
    void panel.webview.postMessage(message);
  }

  /** Reads the ticket, changes it and writes it back (the file may have changed since the view showed it). */
  private async changeTicket(item: BacklogItem, change: (t: Ticket) => Ticket): Promise<void> {
    await this.deps.backlog.writeTicket(item.id, change(await this.deps.backlog.readTicket(item)));
  }

  /** Adds an entry to a ticket's (local) activity: comments, and notes from Flotilla (an agent started). */
  async addActivity(id: string, author: string, body: string): Promise<void> {
    const item = await this.item(id);
    if (!item) return;
    await this.changeTicket(item, (t) => ({ ...t, activity: [...t.activity, { date: entryDate(new Date()), author, body: body.trim() }] }));
  }

  private async onMessage(id: string, panel: vscode.WebviewPanel, m: TicketWebviewMessage): Promise<void> {
    const item = await this.item(id);
    if (!item) return;
    const backlog = this.deps.backlog;
    switch (m.type) {
      case 'ready':
        break;
      case 'title': {
        const title = m.title.trim();
        if (!title || title === item.title) return;
        await backlog.change((d) => updateItem(d, id, { title }));
        await this.changeTicket(item, (t) => ({ ...t, title }));
        break;
      }
      case 'description':
        await this.changeTicket(item, (t) => ({ ...t, title: item.title, description: m.text }));
        break;
      case 'comment':
        if (!m.text.trim()) return;
        if (item.remote) {
          const source = await this.deps.integrations.sourceOf(id);
          if (!source) throw new Error('Its integration is no longer connected.');
          await source.comment(id, m.text.trim());
        } else {
          await this.addActivity(id, 'You', m.text);
        }
        break;
      case 'openRemote':
        if (item.remote) await vscode.env.openExternal(vscode.Uri.parse(item.remote.url));
        return;
      case 'status':
        await backlog.change((d) => updateItem(d, id, { status: m.status }));
        break;
      case 'priority':
        await backlog.change((d) => updateItem(d, id, { priority: m.priority }));
        break;
      case 'image': {
        const bytes = Buffer.from(m.data, 'base64');
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Images can be at most 10 MB.');
        const rel = await backlog.saveImage(id, m.name, bytes);
        const reply: TicketHostMessage = { type: 'imageSaved', requestId: m.requestId, markdown: `![${path.basename(rel)}](${rel})` };
        void panel.webview.postMessage(reply);
        return;
      }
      case 'start':
        await vscode.commands.executeCommand('flotilla.startBacklogItem', id, { agent: m.agent });
        return;
      case 'writeWithAI':
        await vscode.commands.executeCommand('flotilla.writeBacklogItem', id);
        return;
      case 'openFile':
        await vscode.window.showTextDocument(vscode.Uri.file(await backlog.ensureDocument(item)), { preview: false });
        return;
      case 'openWorktree':
        if (this.worktreesOf(item).some((w) => w.key === m.key)) this.deps.revealWorktree(m.key);
        return;
    }
    await this.post(id, panel);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('ticket.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('ticket.js')}"></script>
</body>
</html>`;
  }
}
