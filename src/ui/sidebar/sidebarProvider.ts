import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { openChangeDiff, openChangesEditor } from '../../core/diff/openDiff';
import { runGit } from '../../core/git/gitCli';
import { resolveInside } from '../../core/paths';
import { toWorkspaceUri } from '../../core/uris';
import { compareRefs, listRefs } from '../../features/diffs/compare';
import { addItem, idProblem, moveItem, nextId, removeItem, updateItem, type BacklogItem } from '../../features/backlog/backlog';
import { summaryOf } from '../../features/backlog/ticket';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import type { BacklogIntegrations } from '../backlog/integrations';
import { commitChanges, readLog } from '../../features/history/log';
import { resolveBase } from '../../features/workstreams/progress';
import type { Workstream } from '../../features/workstreams/workstream';
import { searchWorktree } from '../../features/search/gitGrep';
import { matcher, replacementFor, type SearchOptions } from '../../features/search/matcher';
import { ALL, type BacklogItemView, type HostMessage, type RefComparison, type SearchGroup, type Tool, type WebviewMessage } from '../../webview/protocol';
import type { FileChange } from '../../core/git/porcelain';
import type { ActiveWorktree } from '../activeWorktree';
import { FileOps } from './fileOps';
import { iconThemeRoot, loadIconTheme } from './iconTheme';
import { excludeMatcher, listDirectory, markIgnored } from './files';
import { tabOrder, toWorkstreamView } from './viewModel';

/** Commits per page of a worktree's history. */
const LOG_PAGE = 50;

export interface SidebarDeps {
  extensionUri: vscode.Uri;
  repository: Repository<Workstream>;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  inWorkspace: (ws: Workstream) => boolean;
  active: ActiveWorktree;
  backlog: LocalBacklog;
  integrations: BacklogIntegrations;
  /** Commits with the message from the webview's message box; true when a commit was made. */
  commit: (ws: Workstream, message: string, opts: { amend?: boolean; then?: 'push' | 'sync' }) => Promise<boolean>;
  output: vscode.OutputChannel;
}

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'flotilla.sidebar';
  private view: vscode.WebviewView | undefined;
  /** The page has loaded and listens; until then actions wait in pending. */
  private ready = false;
  private pending: HostMessage[] = [];
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
      deps.backlog.watch(() => void this.backlogChanged()),
      deps.integrations.onDidChange(() => void this.postBacklog()),
    );
  }

  /** A ticket's heading may have been edited (by hand or by an agent): that renames the item. */
  private async backlogChanged(): Promise<void> {
    await this.deps.backlog.syncTitles().catch(() => false);
    await this.postBacklog();
  }

  private async postBacklog(): Promise<void> {
    const store = this.deps.backlog;
    const data = await store.read();
    const items = await Promise.all(
      data.items.map(async (item) => {
        const ticket = await store.readTicket(item);
        return { ...item, summary: summaryOf(ticket.description), activity: ticket.activity.length };
      }),
    );
    // Issues from integrations follow the local items, in their tracker's order.
    const sources = this.deps.integrations.current;
    const remote: BacklogItemView[] = sources.flatMap((s) =>
      s.issues.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        priority: i.priority,
        created: '',
        activity: 0,
        source: { kind: s.config.kind, label: s.label, url: i.url, statusName: i.statusName },
      })),
    );
    const problems = sources.filter((s) => s.error).map((s) => ({ label: s.label, error: s.error! }));
    const defaultPrefix = vscode.workspace.getConfiguration('flotilla').get<string>('backlog.idPrefix', 'BL').trim() || 'BL';
    this.post({ type: 'backlog', items: [...items, ...remote], problems, integrations: sources.length, defaultPrefix, counters: data.counters ?? {} });
  }

  private async onBacklog(m: Extract<WebviewMessage, { type: 'backlog' }>): Promise<void> {
    const store = this.deps.backlog;
    switch (m.op) {
      case 'add': {
        if (!m.title.trim()) return;
        const prefix = vscode.workspace.getConfiguration('flotilla').get<string>('backlog.idPrefix', 'BL').trim() || 'BL';
        let added: BacklogItem | undefined;
        const id = m.id?.trim() || undefined;
        // Ids of issues from integrations are taken too (they'd link to the same branches).
        const taken = this.deps.integrations.issues().map((i) => i.id);
        if (id) {
          const problem = idProblem(await store.read(), id, taken);
          if (problem) {
            void vscode.window.showWarningMessage(problem);
            return;
          }
        }
        await store.change((d) => {
          const result = addItem(d, m.title, prefix, new Date(), id ?? nextId(d, prefix, taken));
          added = result.item;
          return result.data;
        });
        await this.postBacklog();
        if (added && m.then === 'open') await vscode.commands.executeCommand('flotilla.openBacklogItem', added.id);
        if (added && m.then === 'ai') await vscode.commands.executeCommand('flotilla.writeBacklogItem', added.id);
        return;
      }
      case 'update':
        await store.change((d) =>
          updateItem(d, m.id, {
            ...(m.title?.trim() ? { title: m.title.trim() } : {}),
            ...(m.notes !== undefined ? { notes: m.notes.trim() || undefined } : {}),
            ...(m.status ? { status: m.status } : {}),
            ...(m.priority !== undefined ? { priority: m.priority } : {}),
          }),
        );
        break;
      case 'move':
        await store.change((d) => moveItem(d, m.id, m.status, m.before));
        break;
      case 'delete': {
        const item = (await store.read()).items.find((i) => i.id === m.id);
        if (!item) return;
        const choice = await vscode.window.showWarningMessage(`Delete ${item.id} '${item.title}' from the backlog?`, { modal: true }, 'Delete');
        if (choice !== 'Delete') return;
        await store.change((d) => removeItem(d, m.id));
        await store.deleteDocument(m.id);
        break;
      }
      case 'start':
        await vscode.commands.executeCommand('flotilla.startBacklogItem', m.id, { agent: true });
        return;
      case 'open':
        await vscode.commands.executeCommand('flotilla.openBacklogItem', m.id);
        return;
      case 'ai':
        await vscode.commands.executeCommand('flotilla.writeBacklogItem', m.id);
        return;
      case 'integrations':
        await this.deps.integrations.manage();
        return;
      case 'refresh':
        await this.deps.integrations.refresh();
        break;
    }
    await this.postBacklog();
  }

  /** Folds or unfolds every worktree on the All tab (the view title's Fold All / Unfold All). */
  fold(folded: boolean): void {
    this.post({ type: 'fold', folded });
  }

  /** Shows the Backlog tool with a box to name a new item. */
  async addBacklogItem(): Promise<void> {
    await this.showTool('backlog');
    this.act({ type: 'backlogAdd' });
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const iconRoot = iconThemeRoot(this.deps.extensionUri);
    view.webview.options = { enableScripts: true, localResourceRoots: iconRoot ? [dist, iconRoot] : [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m).catch((e: unknown) => this.report(e)));
    view.onDidChangeVisibility(() => this.visibility.fire(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
      this.visibility.fire(false);
    });
    this.visibility.fire(view.visible);
    // A new icon theme may live in another extension's folder: allow it (this reloads the webview), then send it.
    view.onDidDispose(
      vscode.Disposable.from(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (!e.affectsConfiguration('workbench.iconTheme')) return;
          const root = iconThemeRoot(this.deps.extensionUri);
          this.ready = false;
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
    this.act({ type: 'reveal', key, path: relPath, tool });
  }

  /** Sends an action (reveal, show a tool, …) now, or once the page is ready, so it isn't lost while it loads. */
  private act(message: HostMessage): void {
    if (this.view && this.ready) this.post(message);
    else this.pending.push(message);
  }

  /** Shows the sidebar on the given tool. */
  async showTool(tool: Tool): Promise<void> {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    this.act({ type: 'tool', tool });
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
        void this.postBacklog();
        this.ready = true;
        this.pending.splice(0).forEach((message) => this.post(message));
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
      case 'log':
        await this.postLog(m.key, m.skip);
        return;
      case 'backlog':
        await this.onBacklog(m);
        return;
      case 'folding':
        await vscode.commands.executeCommand('setContext', 'flotilla.canFold', m.canFold);
        await vscode.commands.executeCommand('setContext', 'flotilla.allFolded', m.allFolded);
        return;
      case 'openCommit': {
        const ws = this.find(m.key);
        if (!ws?.worktree.path || !/^[0-9a-f]{4,64}$/.test(m.hash)) return;
        const { changes, parent } = await commitChanges(ws.worktree.path, m.hash);
        const subject = (await runGit(['log', '-n', '1', '--format=%h %s', m.hash, '--'], { cwd: ws.worktree.path })).trim();
        if (m.path !== undefined) {
          const change = changes.find((c) => c.path === m.path);
          if (change) await openChangeDiff(this.deps.reference, ws.worktree.path, change, parent, m.hash, subject);
          return;
        }
        if (!changes.length) {
          void vscode.window.showInformationMessage(`${subject} changes no files.`);
          return;
        }
        await openChangesEditor(this.deps.reference, ws.worktree.path, changes, parent, m.hash, subject);
        return;
      }
      case 'commitFiles': {
        const dir = this.root(m.key);
        if (!dir || !/^[0-9a-f]{4,64}$/.test(m.hash)) return;
        try {
          const { changes } = await commitChanges(dir, m.hash);
          this.post({ type: 'commitFiles', key: m.key, hash: m.hash, files: changes });
        } catch (error) {
          this.post({ type: 'commitFiles', key: m.key, hash: m.hash, files: [], error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
      case 'refs': {
        const dir = this.compareDir();
        if (!dir) return;
        const [refs, defaultBase] = await Promise.all([
          listRefs(dir).catch(() => ({ local: [], remote: [], tags: [] })),
          resolveBase(dir, vscode.workspace.getConfiguration('flotilla').get<string>('defaultBase', '')),
        ]);
        this.post({ type: 'refs', defaultBase, ...refs });
        return;
      }
      case 'compare': {
        try {
          const { files } = await this.compareRefs(m);
          this.post({ type: 'compared', id: m.id, files });
        } catch (error) {
          this.post({ type: 'compared', id: m.id, files: [], error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'openCompare': {
        const { dir, result } = await this.compareRefs(m);
        const title = `${m.base} ↔ ${m.head}${m.worktree ? ' (working tree)' : ''}`;
        if (m.path === undefined) {
          if (result.files.length) await openChangesEditor(this.deps.reference, dir, result.files, result.leftRef, result.rightRef, title);
          return;
        }
        const change = result.files.find((f) => f.path === m.path);
        if (change) await openChangeDiff(this.deps.reference, dir, change, result.leftRef, result.rightRef, title);
        return;
      }
    }
  }

  /** Where refs are compared: any reachable worktree (they share refs), the main one first. */
  private compareDir(): string | undefined {
    const reachable = this.deps.repository.current.filter((w) => w.worktree.path);
    return (reachable.find((w) => w.worktree.isMain) ?? reachable[0])?.worktree.path;
  }

  private async compareRefs(m: RefComparison): Promise<{ dir: string; result: Awaited<ReturnType<typeof compareRefs>> } & { files: FileChange[] }> {
    const dir = m.worktree ? this.root(m.worktree) : this.compareDir();
    if (!dir) throw new Error('That worktree is not reachable from this environment.');
    const result = await compareRefs(dir, m.base, m.head, 'twoDot', m.worktree !== undefined);
    return { dir, result, files: result.files };
  }

  private async postLog(key: string, skip: number): Promise<void> {
    const ws = this.find(key);
    const head = ws?.sync.head;
    if (!ws?.worktree.path || !head) {
      this.post({ type: 'log', key, head, skip, commits: [], more: false });
      return;
    }
    try {
      const page = await readLog(ws.worktree.path, { skip, limit: LOG_PAGE, upstream: ws.sync.upstream, hasRemote: ws.sync.hasRemote });
      this.post({ type: 'log', key, head, skip, ...page });
    } catch (error) {
      this.post({ type: 'log', key, head, skip, commits: [], more: false, error: error instanceof Error ? error.message : String(error) });
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
