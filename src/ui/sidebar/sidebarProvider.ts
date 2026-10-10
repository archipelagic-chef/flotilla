import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { toWorkspaceUri } from '../../core/uris';
import type { Workstream } from '../../features/workstreams/workstream';
import { searchWorktree } from '../../features/search/gitGrep';
import { ALL, type HostMessage, type SearchGroup, type Tool, type WebviewMessage } from '../../webview/protocol';
import type { ActiveWorktree } from '../activeWorktree';
import { FileOps } from './fileOps';
import { excludeMatcher, listDirectory } from './files';
import { tabOrder, toWorkstreamView } from './viewModel';

export interface SidebarDeps {
  extensionUri: vscode.Uri;
  repository: Repository<Workstream>;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  inWorkspace: (ws: Workstream) => boolean;
  active: ActiveWorktree;
  /** Commits with the message from the webview's message box; true when a commit was made. */
  commit: (ws: Workstream, message: string) => Promise<boolean>;
  output: vscode.OutputChannel;
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'flotilla.sidebar';
  private view: vscode.WebviewView | undefined;
  private pendingReveal: HostMessage | undefined;
  private readonly visibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibility.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly files: FileOps;

  constructor(private readonly deps: SidebarDeps) {
    this.files = new FileOps({
      reference: deps.reference,
      find: (key) => this.find(key),
      post: (message) => this.post(message),
      dirsChanged: (key, dirs) => this.dirsChanged(key, [...new Set(dirs)]),
    });
    this.subscriptions.push(
      { dispose: deps.repository.onDidChange(() => this.postState()).dispose },
      deps.active.onDidChange((key) => this.post({ type: 'active', key })),
    );
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m).catch((e: unknown) => this.report(e)));
    view.onDidChangeVisibility(() => this.visibility.fire(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
      this.visibility.fire(false);
    });
    this.visibility.fire(view.visible);
  }

  postState(): void {
    const now = new Date();
    const all = this.deps.repository.current;
    this.post({ type: 'state', workstreams: tabOrder(all).map((ws) => toWorkstreamView(ws, all, now, this.deps.inWorkspace(ws))) });
  }

  /** Shows a workstream; with path, also expands to and highlights that file in the Files tool. */
  reveal(key: string, relPath?: string, tool?: Tool): void {
    const message: HostMessage = { type: 'reveal', key, path: relPath, tool };
    if (this.view) this.post(message);
    else this.pendingReveal = message;
  }

  /** Shows the sidebar on the given tool. */
  async showTool(tool: Tool): Promise<void> {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    const message: HostMessage = { type: 'tool', tool };
    if (this.view) this.post(message);
    else this.pendingReveal = message;
  }

  dirsChanged(key: string, paths: string[]): void {
    this.post({ type: 'dirsChanged', key, paths });
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.visibility.dispose();
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** The worktree folder of a workstream, when reachable. */
  root(key: string): string | undefined {
    return this.find(key)?.worktree.path;
  }

  private find(key: string): Workstream | undefined {
    return this.deps.repository.current.find((w) => w.key === key);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.postState();
        this.post({ type: 'active', key: this.deps.active.key });
        if (this.pendingReveal) this.post(this.pendingReveal);
        this.pendingReveal = undefined;
        return;
      case 'listDir': {
        const ws = this.find(m.key);
        if (!ws?.worktree.path) return;
        const exclude = vscode.workspace.getConfiguration('files', this.deps.reference).get<Record<string, unknown>>('exclude') ?? {};
        let entries: Awaited<ReturnType<typeof listDirectory>> = [];
        try {
          entries = await listDirectory(ws.worktree.path, m.path, { hideWorktrees: ws.worktree.isMain, isExcluded: excludeMatcher(exclude) });
        } catch {
          // deleted meanwhile: show it empty
        }
        this.post({ type: 'dir', key: m.key, path: m.path, entries });
        return;
      }
      case 'openFile': {
        const ws = this.find(m.key);
        if (!ws?.worktree.path) return;
        const uri = toWorkspaceUri(this.deps.reference, path.join(ws.worktree.path, m.path));
        const selection = m.line ? new vscode.Range(m.line - 1, m.range?.[0] ?? 0, m.line - 1, m.range?.[1] ?? 0) : undefined;
        await vscode.window.showTextDocument(uri, { preview: m.preview, preserveFocus: m.preview && !selection, selection });
        return;
      }
      case 'active':
        this.deps.active.set(m.key);
        return;
      case 'search':
        await this.search(m.id, m.scope, m.query, m.options);
        return;
      case 'openView':
        await vscode.commands.executeCommand(m.view === 'debug' ? 'workbench.view.debug' : 'workbench.view.extensions');
        return;
      case 'commit': {
        const ws = this.find(m.key);
        if (ws && (await this.deps.commit(ws, m.message))) this.post({ type: 'committed', key: m.key });
        return;
      }
      case 'create':
        this.post({ type: 'editResult', ...(await this.editResult(() => this.files.create(m.key, m.kind, m.dir, m.name))) });
        return;
      case 'rename':
        this.post({ type: 'editResult', ...(await this.editResult(() => this.files.rename(m.key, m.path, m.name))) });
        return;
      case 'move':
        await this.files.move(m.from, m.to);
        return;
      case 'command':
        if (!m.command.startsWith('flotilla.')) return;
        await vscode.commands.executeCommand(m.command, m.target);
        return;
    }
  }

  private async search(id: number, scope: string, query: string, options: Parameters<typeof searchWorktree>[2]): Promise<void> {
    const targets = this.deps.repository.current.filter((w) => w.worktree.path && (scope === ALL || w.key === scope));
    try {
      const results = await Promise.all(targets.map(async (w) => ({ key: w.key, result: await searchWorktree(w.worktree.path!, query, options, 1000) })));
      const groups: SearchGroup[] = results.filter((r) => r.result.files.length).map((r) => ({ key: r.key, files: r.result.files }));
      this.post({ type: 'searchResults', id, groups, truncated: results.some((r) => r.result.truncated) });
    } catch (error) {
      this.post({ type: 'searchResults', id, groups: [], truncated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async editResult(run: () => Promise<string | undefined>): Promise<{ ok: boolean; error?: string }> {
    try {
      const error = await run();
      return error ? { ok: false, error } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}
