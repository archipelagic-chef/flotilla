import * as path from 'node:path';
import * as vscode from 'vscode';
import { GIT_SCHEME, GitContentProvider } from './core/diff/gitContentProvider';
import { getGitVersion, GitError, MIN_GIT_VERSION, runGit, versionAtLeast } from './core/git/gitCli';
import { locateRepo } from './core/repoLocator';
import { Repository } from './core/repository';
import { toWorkspaceUri } from './core/uris';
import { deleteHeartbeat, envFromRemoteName, HEARTBEAT_FILE, HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './features/workstreams/heartbeat';
import { buildWorkstreams, type Workstream } from './features/workstreams/workstream';
import { WorktreeService } from './features/worktrees/worktreeService';
import { openWorktree, registerCommands, resumePendingActions, type CommandContext } from './ui/commands';
import { AttentionNotifier } from './ui/notifications';
import { readSettings } from './ui/settings';
import { WorkstreamStatusBar } from './ui/statusBar';
import { WorkstreamsView } from './ui/workstreamsView';

const BACKGROUND_POLL_SECONDS = 60;
let heartbeatGitDir: string | undefined;

function setState(state: 'ready' | 'noRepo' | 'gitMissing'): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', 'switchyard.state', state);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Switchyard');
  context.subscriptions.push(output, vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()));

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    await setState('noRepo');
    return;
  }
  const cwd = folder.uri.fsPath;
  const version = await getGitVersion(cwd);
  if (!version || !versionAtLeast(version, MIN_GIT_VERSION)) {
    await setState('gitMissing');
    void vscode.window.showErrorMessage(
      `Switchyard needs git ${MIN_GIT_VERSION.join('.')} or newer in this environment (${version ? `found ${version.join('.')}` : 'git not found'}).`,
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
    await setState('noRepo');
    return;
  }

  const service = new WorktreeService(location, () => ({ autoAdopt: readSettings().autoAdopt }));
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
  const view = new WorkstreamsView(repository);
  const treeView = vscode.window.createTreeView('switchyard.workstreams', { treeDataProvider: view, showCollapseAll: true });
  const ctx: CommandContext = { extension: context, service, repository, view, reference: folder.uri, currentRoot: location.worktreeRoot, output };
  context.subscriptions.push(
    view,
    treeView,
    new WorkstreamStatusBar(repository),
    new AttentionNotifier(repository, (ws, newWindow) => openWorktree(ctx, ws.worktree.path!, newWindow)),
    { dispose: () => repository.dispose() },
  );
  registerCommands(ctx);
  await setState('ready');

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
    [location.commonDir, '{HEAD,workstream.json}'],
    [path.join(location.mainRoot, '.worktrees'), '*'],
  ];
  for (const [base, glob] of watched) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(toWorkspaceUri(folder.uri, base), glob));
    const onEvent = (uri: vscode.Uri) => {
      if (!uri.path.endsWith(`/${HEARTBEAT_FILE}`)) refresh();
    };
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    context.subscriptions.push(watcher);
  }
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const schedulePoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    const seconds = treeView.visible ? readSettings().pollSeconds : BACKGROUND_POLL_SECONDS;
    pollTimer = setInterval(refresh, Math.max(5, seconds) * 1000);
  };
  schedulePoll();
  context.subscriptions.push(
    treeView.onDidChangeVisibility(() => {
      schedulePoll();
      if (treeView.visible) refresh();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('switchyard')) {
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
