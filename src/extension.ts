import * as path from 'node:path';
import * as vscode from 'vscode';
import { GIT_SCHEME, GitContentProvider } from './core/diff/gitContentProvider';
import { getGitVersion, GitError, MIN_GIT_VERSION, runGit, versionAtLeast } from './core/git/gitCli';
import { locateRepo } from './core/repoLocator';
import { Repository } from './core/repository';
import { toWorkspaceUri } from './core/uris';
import { deleteHeartbeat, envFromRemoteName, HEARTBEAT_INTERVAL_MS, isHeartbeatPath, writeHeartbeat } from './features/workstreams/heartbeat';
import { buildWorkstreams, findWorkstreamFor, type Workstream } from './features/workstreams/workstream';
import { WorktreeService } from './features/worktrees/worktreeService';
import { toGitPath } from './core/paths';
import * as chatUi from './ui/chatCommands';
import { chatContext, openWorktree, registerCommands, resumePendingActions, type CommandContext } from './ui/commands';
import { commit, scmContext } from './ui/scmCommands';
import { ActiveWorktree } from './ui/activeWorktree';
import { closeTabs, offerActivityBar, selectWorktree, newTerminal, offerWorktreeTerminals, TERMINAL_PROFILE_ID, usesWorktreeTerminals, useWorktreeTerminals, worktreeTerminalOptions } from './ui/activeWorktreeCommands';
import { workstreamLabel } from './ui/format';
import { quickOpenInWorktree } from './ui/quickOpen';
import { registerFileCommands } from './ui/sidebar/fileCommands';
import { LocalBacklog } from './features/backlog/localBacklog';
import { SidebarProvider } from './ui/sidebar/sidebarProvider';
import { ExplorerDecorations } from './ui/explorerDecorations';
import { AttentionNotifier } from './ui/notifications';
import { readSettings } from './ui/settings';
import { WorkstreamStatusBar } from './ui/statusBar';
import { extraWorkspaceFolder } from './ui/workspaceFolders';

const BACKGROUND_POLL_SECONDS = 60;
let heartbeatGitDir: string | undefined;

function setState(state: 'ready' | 'noRepo' | 'gitMissing'): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', 'flotilla.state', state);
}

const NO_REPO_TEXT = 'Open a folder inside a git repository to manage workstreams.';

/** Shows a plain message in the sidebar when Flotilla can't run (no repository, no git). */
function showMessageView(context: vscode.ExtensionContext, text: string): void {
  const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, {
      resolveWebviewView(view) {
        view.webview.html = `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-descriptionForeground); padding: 8px 12px;">${escaped}</body></html>`;
      },
    }),
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Flotilla');
  context.subscriptions.push(output, vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()));
  // The terminal profile VS Code's + button uses once it's the default profile. It's registered first, so that it
  // always answers (a plain terminal) when Flotilla has no worktrees to offer: the setting applies to every window.
  let terminalOptions: (() => Promise<vscode.TerminalOptions | undefined>) | undefined;
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(TERMINAL_PROFILE_ID, {
      async provideTerminalProfile() {
        return new vscode.TerminalProfile((await terminalOptions?.()) ?? {});
      },
    }),
  );

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    showMessageView(context, NO_REPO_TEXT);
    await setState('noRepo');
    return;
  }
  const cwd = folder.uri.fsPath;
  const version = await getGitVersion(cwd);
  if (!version || !versionAtLeast(version, MIN_GIT_VERSION)) {
    showMessageView(context, `Flotilla needs git ${MIN_GIT_VERSION.join('.')} or newer in this environment.`);
    await setState('gitMissing');
    void vscode.window.showErrorMessage(
      `Flotilla needs git ${MIN_GIT_VERSION.join('.')} or newer in this environment (${version ? `found ${version.join('.')}` : 'git not found'}).`,
    );
    return;
  }
  const location = await locateRepo(cwd);
  if (!location) {
    const probe = await runGit(['rev-parse', '--git-dir'], { cwd }).catch((e: unknown) => e);
    if (probe instanceof GitError && /relativeworktrees/i.test(probe.stderr)) {
      void vscode.window.showWarningMessage(
        `This repository uses git's relative worktree paths (extensions.relativeWorktrees), which need git 2.48+. This environment has git ${version.join('.')}.`,
      );
    }
    showMessageView(context, NO_REPO_TEXT);
    await setState('noRepo');
    return;
  }

  const service = new WorktreeService(location, () => ({
    autoAdopt: readSettings().autoAdopt,
    onAdoptError: (wt, error) =>
      output.appendLine(`Could not make ${wt.path ?? wt.adminDir} portable: ${error instanceof Error ? error.message : String(error)}`),
  }));
  const repository = new Repository<Workstream>(
    () =>
      buildWorkstreams(service, {
        currentWorktreeRoot: location.worktreeRoot,
        settings: readSettings(),
        now: new Date(),
        onInvalidStatus: (file) => output.appendLine(`Ignoring invalid agent status file: ${file}`),
      }),
    300,
    (error) => output.appendLine(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  const inWorkspace = (ws: Workstream) => extraWorkspaceFolder(ws.worktree.path) !== undefined;
  const scmCtx = scmContext(repository);
  const active = new ActiveWorktree(context.workspaceState);
  const backlog = new LocalBacklog(location.commonDir);
  // A cancelled pick still opens a terminal (VS Code expects one): in this window's folder.
  terminalOptions = async () => (await worktreeTerminalOptions(repository, active, location.worktreeRoot, false)) ?? { cwd: location.worktreeRoot };
  const sidebar = new SidebarProvider({
    extensionUri: context.extensionUri,
    repository,
    reference: folder.uri,
    inWorkspace,
    active,
    commit: (ws, message, opts) => commit(scmCtx, ws, message, opts),
    output,
    backlog,
  });
  const decorations = new ExplorerDecorations(repository, folder.uri, inWorkspace);
  const ctx: CommandContext = {
    extension: context,
    service,
    repository,
    sidebar: { reveal: (key) => sidebar.reveal(key) },
    reference: folder.uri,
    currentRoot: location.worktreeRoot,
    currentGitDir: location.gitDir,
    activeKey: () => active.key,
    output,
    backlog,
  };
  context.subscriptions.push(
    sidebar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    active,
    new WorkstreamStatusBar(repository, active),
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    new AttentionNotifier(repository, (ws, newWindow) => openWorktree(ctx, ws.worktree.path!, newWindow)),
    { dispose: () => repository.dispose() },
  );
  registerCommands(ctx);
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.showSidebar', () => vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)),
    vscode.commands.registerCommand('flotilla.showOverview', () => sidebar.showTool('overview')),
    vscode.commands.registerCommand('flotilla.showBacklog', () => sidebar.showTool('backlog')),
    vscode.commands.registerCommand('flotilla.foldAll', () => sidebar.fold(true)),
    vscode.commands.registerCommand('flotilla.unfoldAll', () => sidebar.fold(false)),
    vscode.commands.registerCommand('flotilla.addBacklogItem', () => sidebar.addBacklogItem()),
    vscode.commands.registerCommand('flotilla.showFiles', () => sidebar.showTool('files')),
    vscode.commands.registerCommand('flotilla.showSearch', () => sidebar.showTool('search')),
    vscode.commands.registerCommand('flotilla.showVersionControl', () => sidebar.showTool('vc')),
    vscode.commands.registerCommand('flotilla.showChats', () => sidebar.showTool('chats')),
    vscode.commands.registerCommand('flotilla.selectWorktree', (arg?: unknown) => selectWorktree(arg, repository, active)),
    vscode.commands.registerCommand('flotilla.closeTab', (arg?: unknown) => closeTabs(arg, repository, active, false)),
    vscode.commands.registerCommand('flotilla.closeOtherTabs', (arg?: unknown) => closeTabs(arg, repository, active, true)),
    vscode.commands.registerCommand('flotilla.newTerminal', () => newTerminal(repository, active, location.worktreeRoot, false)),
    vscode.commands.registerCommand('flotilla.newTerminalIn', () => newTerminal(repository, active, location.worktreeRoot, true)),
    vscode.commands.registerCommand('flotilla.useWorktreeTerminals', () => useWorktreeTerminals(context, true)),
    vscode.commands.registerCommand('flotilla.quickOpen', () => {
      const ws = repository.current.find((w) => w.key === active.key);
      if (!ws?.worktree.path) return vscode.commands.executeCommand('workbench.action.quickOpen');
      return quickOpenInWorktree(ws, folder.uri);
    }),
    vscode.commands.registerCommand('flotilla.configureActivityBar', () => offerActivityBar(context, true)),
  );
  void offerActivityBar(context, false);
  context.subscriptions.push(offerWorktreeTerminals(context, repository, active));
  // With + opening terminals in the active worktree, the terminal panel's own worktree button is hidden.
  const updateTerminalContext = () => void vscode.commands.executeCommand('setContext', 'flotilla.worktreeTerminals', usesWorktreeTerminals());
  updateTerminalContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('terminal.integrated') && updateTerminalContext()),
  );
  registerFileCommands(context, sidebar, folder.uri, output);
  await setState('ready');
  const chats = chatContext(ctx);

  // Explorer integration: context keys for the worktree folders' "Flotilla" submenu.
  const updateExplorerContext = () => {
    const linked = repository.current.filter((ws) => ws.worktree.path && !ws.worktree.isMain && !ws.isCurrent);
    // Same form as VS Code's `resourcePath` context key: fsPath for file URIs, the URI path otherwise (remote windows).
    const asResourcePath = (uri: vscode.Uri) => (uri.scheme === 'file' ? uri.fsPath : uri.path);
    const fsPaths = (items: Workstream[]) => items.map((ws) => asResourcePath(toWorkspaceUri(folder.uri, ws.worktree.path!)));
    void vscode.commands.executeCommand('setContext', 'flotilla.worktreeFolders', fsPaths(linked));
    void vscode.commands.executeCommand('setContext', 'flotilla.workspaceWorktrees', fsPaths(linked.filter(inWorkspace)));
  };
  // Editor -> sidebar: reveal the active file in its worktree, like the Explorer's auto-reveal.
  const revealActive = (editor: vscode.TextEditor | undefined) => {
    const uri = editor?.document.uri;
    if (!uri || !sidebar.visible || uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority) return;
    const ws = findWorkstreamFor(repository.current, uri.fsPath);
    if (ws?.worktree.path) sidebar.reveal(ws.key, toGitPath(path.relative(ws.worktree.path, uri.fsPath)));
  };
  // Files tab: tell the webview which listed directories changed. Content changes don't alter listings.
  const changedDirs = new Map<string, Set<string>>();
  let dirTimer: ReturnType<typeof setTimeout> | undefined;
  const onFileEvent = (uri: vscode.Uri) => {
    const ws = findWorkstreamFor(repository.current, uri.fsPath);
    if (!ws?.worktree.path) return;
    const rel = toGitPath(path.relative(ws.worktree.path, path.dirname(uri.fsPath)));
    if (rel.startsWith('..')) return;
    const set = changedDirs.get(ws.key) ?? new Set();
    set.add(rel === '.' ? '' : rel);
    changedDirs.set(ws.key, set);
    dirTimer ??= setTimeout(() => {
      dirTimer = undefined;
      for (const [key, dirs] of changedDirs) sidebar.dirsChanged(key, [...dirs]);
      changedDirs.clear();
    }, 200);
  };
  const filesWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'), false, true, false);
  filesWatcher.onDidCreate(onFileEvent);
  filesWatcher.onDidDelete(onFileEvent);
  context.subscriptions.push(
    filesWatcher,
    repository.onDidChange(updateExplorerContext),
    repository.onDidChange(() => void chatUi.maybeOfferHooks(chats)),
    repository.onDidChange(() => {
      const report = (e: unknown) => output.appendLine(`Chat linking failed: ${e instanceof Error ? e.message : String(e)}`);
      void chatUi.linkPendingChats(chats).catch(report);
      void chatUi.tagLinkedChatTitles(chats).catch(report);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateExplorerContext();
      sidebar.postState();
      decorations.update();
    }),
    vscode.window.onDidChangeActiveTextEditor(revealActive),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (findWorkstreamFor(repository.current, doc.uri.fsPath)) void repository.refresh();
    }),
  );

  // Heartbeat: tells other windows (in any environment) that this worktree is open.
  heartbeatGitDir = location.gitDir;
  const env = envFromRemoteName(vscode.env.remoteName);
  const beat = () => writeHeartbeat(location.gitDir, env).catch((e: unknown) => output.appendLine(`Heartbeat failed: ${String(e)}`));
  void beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

  // Refresh triggers: watchers (unreliable on bind mounts), focus, polling, settings.
  const refresh = () => void repository.refresh();
  const watched: Array<[string, string]> = [
    [path.join(location.commonDir, 'worktrees'), '**'],
    [location.commonDir, '{HEAD,workstream.json,flotilla/**}'],
    [path.join(location.mainRoot, '.worktrees'), '*'],
  ];
  for (const [base, glob] of watched) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(toWorkspaceUri(folder.uri, base), glob));
    const onEvent = (uri: vscode.Uri) => {
      // Heartbeats (and their temp files) change every 30 s in every window; they must not trigger refreshes.
      if (!isHeartbeatPath(uri.path)) refresh();
    };
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    context.subscriptions.push(watcher);
  }
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const schedulePoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    const seconds = sidebar.visible ? readSettings().pollSeconds : BACKGROUND_POLL_SECONDS;
    pollTimer = setInterval(refresh, Math.max(5, seconds) * 1000);
  };
  schedulePoll();
  context.subscriptions.push(
    sidebar.onDidChangeVisibility((visible) => {
      schedulePoll();
      if (visible) refresh();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flotilla')) {
        schedulePoll();
        refresh();
      }
    }),
    { dispose: () => pollTimer && clearInterval(pollTimer) },
  );

  await repository.refresh();
  await resumePendingActions(ctx);
}

export async function deactivate(): Promise<void> {
  if (heartbeatGitDir) await deleteHeartbeat(heartbeatGitDir).catch(() => undefined);
}
