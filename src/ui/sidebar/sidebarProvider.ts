import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { resolveInside } from '../../core/paths';
import { toWorkspaceUri } from '../../core/uris';
import type { Workstream } from '../../features/workstreams/workstream';
import { searchWorktree } from '../../features/search/gitGrep';
import { matcher, replacementFor, type SearchOptions } from '../../features/search/matcher';
import { ALL, type HostMessage, type SearchGroup, type Tool, type WebviewMessage } from '../../webview/protocol';
import type { ActiveWorktree } from '../activeWorktree';
import { FileOps } from './fileOps';
import { iconThemeRoot, loadIconTheme } from './iconTheme';
import { excludeMatcher, listDirectory, markIgnored } from './files';
import { tabOrder, toWorkstreamView } from './viewModel';

export interface SidebarDeps {
  extensionUri: vscode.Uri;
  repository: Repository<Workstream>;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  inWorkspace: (ws: Workstream) => boolean;
  active: ActiveWorktree;
  /** Commits with the message from the webview's message box; true when a commit was made. */
  commit: (ws: Workstream, message: string, opts: { amend?: boolean; then?: 'push' | 'sync' }) => Promise<boolean>;
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
      deps.active.onDidChangeTabs((closed) => this.post({ type: 'tabs', closed: [...closed] })),
    );
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const iconRoot = iconThemeRoot(this.deps.extensionUri);
    view.webview.options = { enableScripts: true, localResourceRoots: iconRoot ? [dist, iconRoot] : [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m).catch((e: unknown) => this.report(e)));
    view.onDidChangeVisibility(() => this.visibility.fire(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
      this.visibility.fire(false);
    });
    this.visibility.fire(view.visible);
    // A new icon theme may live in another extension's folder: allow it (this reloads the webview), then send it.
    view.onDidDispose(
      vscode.Disposable.from(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (!e.affectsConfiguration('workbench.iconTheme')) return;
          const root = iconThemeRoot(this.deps.extensionUri);
          view.webview.options = { enableScripts: true, localResourceRoots: root ? [dist, root] : [dist] };
          void this.postIconTheme();
        }),
        vscode.window.onDidChangeActiveColorTheme(() => void this.postIconTheme()),
      ).dispose,
    );
  }

  private async postIconTheme(): Promise<void> {
    if (!this.view) return;
    try {
      const theme = await loadIconTheme(this.view.webview, this.deps.extensionUri);
      this.post({ type: 'iconTheme', theme: theme && { css: theme.css, map: theme.map } });
    } catch (error) {
      this.deps.output.appendLine(`Could not load the file icon theme: ${error instanceof Error ? error.message : String(error)}`);
      this.post({ type: 'iconTheme', theme: undefined });
    }
  }

  postState(): void {
    const now = new Date();
    const all = this.deps.repository.current;
    const pattern = vscode.workspace.getConfiguration('flotilla').get<string>('tabLabelPattern') || undefined;
    this.post({ type: 'state', workstreams: tabOrder(all).map((ws) => toWorkstreamView(ws, all, now, this.deps.inWorkspace(ws), pattern)) });
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
        void this.postIconTheme();
        this.postState();
        this.post({ type: 'active', key: this.deps.active.key });
        this.post({ type: 'tabs', closed: [...this.deps.active.closedTabs] });
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
          entries = await markIgnored(ws.worktree.path, m.path, entries);
        } catch {
          // deleted meanwhile: show it empty
        }
        this.post({ type: 'dir', key: m.key, path: m.path, entries });
        return;
      }
      case 'openFile': {
        const ws = this.find(m.key);
        if (!ws?.worktree.path) return;
        const uri = toWorkspaceUri(this.deps.reference, resolveInside(ws.worktree.path, m.path));
        const selection = m.line ? new vscode.Range(m.line - 1, m.range?.[0] ?? 0, m.line - 1, m.range?.[1] ?? 0) : undefined;
        await vscode.window.showTextDocument(uri, { preview: m.preview, preserveFocus: m.preview && !selection, selection });
        return;
      }
      case 'active':
        this.deps.active.set(m.key);
        return;
      case 'search':
        await this.search(m.id, m.scope, m.query, m.options, m.limit);
        return;
      case 'replace':
        await this.replace(m.scope, m.query, m.options, m.replacement, m.key, m.path);
        return;
      case 'openView':
        await vscode.commands.executeCommand(m.view === 'debug' ? 'workbench.view.debug' : 'workbench.view.extensions');
        return;
      case 'commit': {
        const ws = this.find(m.key);
        if (ws && (await this.deps.commit(ws, m.message, { amend: m.amend, then: m.then }))) this.post({ type: 'committed', key: m.key });
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

  private async search(id: number, scope: string, query: string, options: SearchOptions, requested?: number): Promise<void> {
    const limit = requested ?? vscode.workspace.getConfiguration('flotilla').get<number>('search.maxResults', 2000);
    const targets = this.deps.repository.current.filter((w) => w.worktree.path && (scope === ALL || w.key === scope));
    try {
      const results = await Promise.all(targets.map(async (w) => ({ key: w.key, result: await searchWorktree(w.worktree.path!, query, options, limit) })));
      const groups: SearchGroup[] = tabOrder(targets)
        .map((w) => results.find((r) => r.key === w.key)!)
        .filter((r) => r.result.files.length)
        .map((r) => ({ key: r.key, files: r.result.files }));
      this.post({ type: 'searchResults', id, groups, truncated: results.some((r) => r.result.truncated), limit });
    } catch (error) {
      this.post({ type: 'searchResults', id, groups: [], truncated: false, limit, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Replaces the matches in the scope (or one file) as one undoable edit; asks first when more than one file changes. */
  private async replace(scope: string, query: string, options: SearchOptions, replacement: string, key?: string, relPath?: string): Promise<void> {
    const re = matcher(query, options);
    if (!re || !query) return;
    const targets = this.deps.repository.current.filter((w) => w.worktree.path && (key ? w.key === key : scope === ALL || w.key === scope));
    const files: vscode.Uri[] = [];
    for (const w of targets) {
      const paths = relPath ? [relPath] : (await searchWorktree(w.worktree.path!, query, options, Number.MAX_SAFE_INTEGER)).files.map((f) => f.path);
      files.push(...paths.map((p) => toWorkspaceUri(this.deps.reference, resolveInside(w.worktree.path!, p))));
    }
    const edit = new vscode.WorkspaceEdit();
    const documents: vscode.TextDocument[] = [];
    let count = 0;
    for (const uri of files) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      let changed = false;
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        edit.replace(uri, new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)), replacementFor(m[0], re, replacement, options));
        changed = true;
        count++;
      }
      if (changed) documents.push(doc);
    }
    if (!count) {
      this.post({ type: 'replaced', count: 0 });
      return;
    }
    if (documents.length > 1) {
      const choice = await vscode.window.showWarningMessage(
        `Replace ${count} occurrence${count === 1 ? '' : 's'} across ${documents.length} files with '${replacement}'?`,
        { modal: true, detail: 'You can undo this in each file (Ctrl+Z).' },
        'Replace',
      );
      if (!choice) return;
    }
    const wasDirty = new Set(documents.filter((d) => d.isDirty).map((d) => d.uri.toString()));
    await vscode.workspace.applyEdit(edit);
    // Files that had no unsaved changes are saved, like a replace on disk; others keep the user's unsaved work open.
    await Promise.all(documents.filter((d) => !wasDirty.has(d.uri.toString())).map((d) => d.save()));
    this.post({ type: 'replaced', count });
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
