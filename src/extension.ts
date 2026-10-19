import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GIT_SCHEME, GitFileSystemProvider } from './core/diff/gitContentProvider';
import { getGitVersion, GitError, MIN_GIT_VERSION, runGit, versionAtLeast } from './core/git/gitCli';
import { locateRepo } from './core/repoLocator';
import { Repository, type Scope } from './core/repository';
import { inBackground } from './core/git/gitQueue';
import { toWorkspaceUri } from './core/uris';
import type { Fetch } from './features/backlog/sources/source';
import { JOB_LOG_SCHEME, JobLogProvider, showJobLog, signedInActions } from './features/ci/jobLog';
import { CiNotifier } from './ui/ci/ciNotifier';
import { deleteHeartbeat, envFromRemoteName, HEARTBEAT_INTERVAL_MS, isHeartbeatPath, writeHeartbeat } from './features/workstreams/heartbeat';
import { scopeForChange } from './features/workstreams/refreshPlan';
import { buildWorkstreams, findWorkstreamFor, type Workstream } from './features/workstreams/workstream';
import { WorktreeService } from './features/worktrees/worktreeService';
import { toGitPath } from './core/paths';
import * as chatUi from './ui/chatCommands';
import { chatContext, commitPrefixMode, openWorktree, prepareItemWorktree, registerCommands, removeWorkstream, resumePendingActions, type CommandContext } from './ui/commands';
import { Autopilot } from './ui/backlog/autopilot';
import { Leader } from './features/backlog/leader';
import { BranchPush } from './ui/backlog/branchPush';
import { MainSync } from './ui/backlog/mainSync';
import { installCommitHook } from './features/backlog/commitHook';
import { BacklogInbox } from './ui/backlog/inboxWatcher';
import { ReviewLoop } from './ui/backlog/reviewLoop';
import { Merger, readyToMerge } from './ui/backlog/merge';
import { levelReport } from './features/backlog/modelLevel';
import { BigChats } from './ui/bigChats';
import { agentChatItem } from './features/backlog/backlog';
import { modelLevels, setAgentDirs, trackTerminals } from './ui/backlog/agentRunner';
import { backlogIdOf } from './ui/backlog/cardMenu';
import { Shaping } from './ui/backlog/shaping';
import { discussable } from './features/backlog/shaping';
import { commit, scmContext } from './ui/scmCommands';
import { ActiveWorktree } from './ui/activeWorktree';
import { closeTabs, offerActivityBar, selectWorktree, newTerminal, offerWorktreeTerminals, TERMINAL_PROFILE_ID, usesWorktreeTerminals, useWorktreeTerminals, worktreeTerminalOptions } from './ui/activeWorktreeCommands';
import { workstreamLabel } from './ui/format';
import { quickOpenInWorktree } from './ui/quickOpen';
import { registerFileCommands } from './ui/sidebar/fileCommands';
import { LocalBacklog } from './features/backlog/localBacklog';
import { BacklogIntegrations } from './ui/backlog/integrations';
import { newBacklogItem } from './ui/backlog/newItem';
import { TicketPanels } from './ui/backlog/ticketPanel';
import { Merges } from './ui/backlog/merges';
import { RunApprovals, RunTerminals } from './ui/backlog/runBlock';
import { SidebarProvider } from './ui/sidebar/sidebarProvider';
import { devGitHubApi } from './ui/ci/devGitHub';
import { heldBy, type ReviewFix } from './features/backlog/review';
import { ExplorerDecorations } from './ui/explorerDecorations';
import { NeedsYouNotifier } from './ui/notifications';
import { readSettings } from './ui/settings';
import { hideWorktrees } from './ui/hygiene';
import { WorkstreamStatusBar } from './ui/statusBar';
import { StorageMonitor } from './ui/storage';
import { FinishedWorktrees } from './ui/finishedWorktrees';
import { SharedFolders } from './ui/sharedFolders';
import { SLOW_STORAGE_DOCS } from './features/storage/storage';
import { extraWorkspaceFolder } from './ui/workspaceFolders';
import { watchInstalledVersion } from './ui/installedVersion';

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
  // An update installed while this window runs only applies after a reload: that's said (BL-85).
  watchInstalledVersion(context);
  context.subscriptions.push(output, vscode.workspace.registerFileSystemProvider(GIT_SCHEME, new GitFileSystemProvider(), { isReadonly: true, isCaseSensitive: true }));
  // A job's CI log, read-only: the CI/CD view opens it through flotilla.showJobLog.
  const jobLogs = new JobLogProvider(signedInActions(globalThis.fetch as unknown as Fetch, devGitHubApi(context.extensionMode)));
  context.subscriptions.push(jobLogs, vscode.workspace.registerTextDocumentContentProvider(JOB_LOG_SCHEME, jobLogs));
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
  const repository: Repository<Workstream> = new Repository<Workstream>(
    (scope) => {
      const build = () =>
        buildWorkstreams(service, {
          currentWorktreeRoot: location.worktreeRoot,
          settings: readSettings(),
          now: new Date(),
          onInvalidStatus: (file) => output.appendLine(`Ignoring invalid agent status file: ${file}`),
          refresh: { scope, previous: repository.current, pollMs: Math.max(5, readSettings().pollSeconds) * 1000, activeKey: active.key },
        });
      // Only a refresh the user asked for (scope 'all') goes ahead of the git processes of other refreshes.
      return scope === 'all' ? build() : inBackground(build);
    },
    300,
    (error) => output.appendLine(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  const inWorkspace = (ws: Workstream) => extraWorkspaceFolder(ws.worktree.path) !== undefined;
  const scmCtx = scmContext(repository);
  const active = new ActiveWorktree(context.workspaceState);
  const backlog = new LocalBacklog(location.mainRoot, location.commonDir);
  // Agents reach their tickets from their worktrees, whatever Claude Code's settings block outside them (BL-89).
  setAgentDirs([backlog.dir]);
  const integrations = new BacklogIntegrations(backlog, context.secrets, location.mainRoot);
  context.subscriptions.push(integrations);
  void integrations.refresh();
  // A cancelled pick still opens a terminal (VS Code expects one): in this window's folder.
  terminalOptions = async () => (await worktreeTerminalOptions(repository, active, location.worktreeRoot, false)) ?? { cwd: location.worktreeRoot };
  const sidebar = new SidebarProvider({
    extensionUri: context.extensionUri,
    repository,
    reference: folder.uri,
    mainRoot: location.mainRoot,
    inWorkspace,
    active,
    commit: (ws, message, opts) => commit(scmCtx, ws, message, opts),
    output,
    backlog,
    integrations,
    githubApi: devGitHubApi(context.extensionMode),
    onCiFinished: (items) => ciNotifier.notify(items),
  });
  // Merge to main (BL-54): it moves its ticket to Done itself, saying what it merged, so the merge watcher leaves those to it.
  const merger = new Merger({ backlog, repository, mainRoot: location.mainRoot, output, openTicket: (id) => void tickets.open(id) });
  // Whether the items' work is merged, read from git: refreshed with the repository (refs move, polling) and the backlog.
  const merges = new Merges({ backlog, mainRoot: location.mainRoot, merging: (id) => merger.isFinishing(id) });
  sidebar.useMerges(merges);
  context.subscriptions.push(
    repository.onDidChange(() => void merges.refresh()),
    backlog.watch(() => void merges.refresh()),
  );
  void merges.refresh();
  const runTerminals = new RunTerminals();
  context.subscriptions.push(runTerminals);
  const tickets = new TicketPanels({ extensionUri: context.extensionUri, mainRoot: service.roots.mainRoot, reference: folder.uri, backlog, integrations, repository, merges, approvals: new RunApprovals(context.workspaceState), terminals: runTerminals, revealWorktree: (key) => sidebar.reveal(key, undefined, 'files'),
    showCommits: (key, ticket, hashes, selected) => sidebar.showCommits(key, ticket, hashes, selected), memento: context.globalState, output,
    ci: sidebar.ci, showCi: (key) => sidebar.showCi(key),
  });
  context.subscriptions.push(tickets);
  // A ticket's run block (its Run button names the entry and the block; without one, the ticket's run), after asking.
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.runBacklogItem', (id?: unknown, block?: unknown) => {
      if (typeof id !== 'string') return;
      const ref = block as { key?: unknown; index?: unknown } | undefined;
      return tickets.run(id, typeof ref?.key === 'string' && typeof ref.index === 'number' ? { key: ref.key, index: ref.index } : undefined);
    }),
  );
  // One window acts on its own for the backlog (the autopilot, agents going on after a usage limit).
  const leader = new Leader(backlog.dir);
  const reviews = new ReviewLoop({
    backlog,
    repository,
    mainRoot: location.mainRoot,
    output,
    isLeader: () => leader.isLeader,
    onApproved: (id, by) => {
      pushes.approved(id);
      merger.approved(id, by);
    },
  });
  const pushes = new BranchPush({ backlog, repository, mainRoot: location.mainRoot, isLeader: () => leader.isLeader, output });
  context.subscriptions.push(reviews, merger, pushes, trackTerminals());
  const reportError = (e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.mergeBacklogItem', async (arg?: unknown) => {
      let id = backlogIdOf(arg);
      if (!id) {
        const ready = (await backlog.read()).items.filter(readyToMerge);
        id = (await vscode.window.showQuickPick(ready.map((i) => ({ label: i.id, description: i.title })), { title: 'Merge a Ticket', placeHolder: ready.length ? 'Tickets ready to merge' : 'No tickets are ready to merge' }))?.label;
      }
      if (id) await merger.merge(id).catch(reportError);
    }),
    vscode.commands.registerCommand('flotilla.mergeAllReady', () => merger.mergeAllReady().catch(reportError)),
    vscode.commands.registerCommand('flotilla.pushMerged', () => merger.push().catch(reportError)),
  );
  // Pause, Resume and Stop on a backlog card's menu (its id in the menu's context), or asking which ticket.
  const controlAgent = (action: 'pause' | 'resume' | 'stop') => async (card?: unknown) => {
    let id = backlogIdOf(card);
    if (!id) {
      const items = (await backlog.read()).items.filter((i) =>
        action === 'resume' ? heldBy(i.review) || i.review?.state === 'paused' : ['working', 'reviewing', 'revising', 'paused'].includes(i.review?.state ?? '') || i.status === 'doing',
      );
      const title = { pause: 'Pause the agent on…', resume: 'Resume the agent on…', stop: 'Stop the agent on…' }[action];
      id = (await vscode.window.showQuickPick(items.map((i) => ({ label: i.id, description: i.title })), { title }))?.label;
    }
    if (id) await tickets.controlAgent(id, action);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.pauseAgent', controlAgent('pause')),
    vscode.commands.registerCommand('flotilla.resumeAgent', controlAgent('resume')),
    vscode.commands.registerCommand('flotilla.stopAgent', controlAgent('stop')),
  );
  // Descriptions edited in the ticket files (by agents, in editors) are noted in their tickets.
  const noteDescriptions = () => void backlog.noteDescriptions().catch((e: unknown) => output.appendLine(`Noting description edits: ${String(e)}`));
  context.subscriptions.push(backlog.watch(() => noteDescriptions()));
  noteDescriptions();
  tickets.useReviews(reviews);
  tickets.useMerger(merger);
  // Open tickets' branches checked against main when either moves (BL-55); Update from Main in the ticket.
  const mainSync = new MainSync({ backlog, repository, reviews, mainRoot: location.mainRoot, isLeader: () => leader.isLeader, output });
  context.subscriptions.push(mainSync);
  tickets.useMainSync(mainSync);
  // Tickets nobody works on yet are talked through with an agent in the ticket (BL-45); Discuss starts that.
  const shaping = new Shaping({ backlog, repository, mainRoot: location.mainRoot, output });
  context.subscriptions.push(shaping);
  tickets.useShaping(shaping);
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.discussBacklogItem', async (id?: unknown) => {
      if (typeof id !== 'string') return;
      const item = (await backlog.read()).items.find((i) => i.id === id);
      if (!item || !discussable(item)) return;
      await tickets.open(id);
      await shaping.discuss(id, true).catch((e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)));
    }),
  );
  // Prioritize: a queued start runs now, above the limit, or pauses a running agent to make room (see reviewLoop).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'flotilla.prioritizeBacklogItem',
      (id: unknown) => typeof id === 'string' && reviews.prioritize(id).catch((e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))),
    ),
  );
  // The "Needs you" list's fix for a stopped review (the same fixes as the ticket's and the notification's).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'flotilla.fixBacklogReview',
      (id: unknown, fix: unknown) =>
        typeof id === 'string' && reviews.fix(id, fix as ReviewFix).catch((e: unknown) => void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))),
    ),
  );
  const inbox = new BacklogInbox(backlog, integrations, repository, { mainRoot: location.mainRoot, commonDir: location.commonDir });
  context.subscriptions.push(inbox);
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
    tickets,
    integrations,
  };
  // The CI notices (a run on a worktree's branch finished): the leading window tells the user, and reads the runs while the sidebar is hidden to see them.
  const ciNotifier = new CiNotifier({
    repository,
    isLeader: () => leader.isLeader,
    show: (key) => sidebar.showCi(key),
    actions: signedInActions(globalThis.fetch as unknown as Fetch, devGitHubApi(context.extensionMode)),
  });
  const updateCiReads = () => sidebar.setKeepReading(leader.isLeader && readSettings().ciNotify !== 'off');
  // What needs the user: the status bar counts it, and it notifies (only the leading window does).
  const needs = new NeedsYouNotifier({
    backlog,
    repository,
    reviews,
    leader,
    openTicket: (id) => void tickets.open(id),
    openWorktree: (ws, newWindow) => openWorktree(ctx, ws.worktree.path!, newWindow),
  });
  context.subscriptions.push(
    sidebar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    active,
    new WorkstreamStatusBar(repository, active, needs),
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    needs,
    { dispose: () => repository.dispose() },
  );
  registerCommands(ctx);
  // A done ticket's worktree is removed (its branch kept), so finished work doesn't fill the drive.
  const finished = new FinishedWorktrees({
    backlog,
    repository,
    service: ctx.service,
    leader,
    workspaceState: context.workspaceState,
    output,
    removeAnyway: (ws) => removeWorkstream(ctx, ws),
  });
  context.subscriptions.push(finished, vscode.commands.registerCommand('flotilla.keptWorktrees', () => finished.showKept()));
  // Worktrees' copies of flotilla.linkFolders share the main worktree's files, made before the setting or not.
  const shared = new SharedFolders({ repository, leader, mainRoot: location.mainRoot, workspaceState: context.workspaceState, output });
  context.subscriptions.push(shared, vscode.commands.registerCommand('flotilla.shareLinkedFolders', () => shared.shareNow()));
  // One of the user's chats grew big: once, a word on what that costs (BL-70).
  context.subscriptions.push(new BigChats({ repository, leader, globalState: context.globalState }));
  // How finished tickets fared per model level: review rounds, and which moved up (BL-69).
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.modelLevelReport', async () => {
      // What each ticket's agents re-read, from their chats still around.
      const reRead = new Map<string, number>();
      for (const c of repository.current.flatMap((w) => w.chats)) {
        const item = agentChatItem(c.firstPrompt)?.item;
        if (item && c.usage) reRead.set(item, (reRead.get(item) ?? 0) + c.usage.reRead);
      }
      output.appendLine(levelReport((await backlog.read()).items, modelLevels(), reRead).join('\n'));
      output.show(true);
    }),
  );
  let autopilotKey: Promise<string> | undefined;
  const autopilot = new Autopilot({
    backlog,
    repository,
    reviews,
    leader,
    output,
    prepareWorktree: (item) => prepareItemWorktree(ctx, item),
    // Signs the autopilot's switch: made once per machine, kept where agents can't read it.
    key: () =>
      (autopilotKey ??= (async () => {
        let key = await context.secrets.get('flotilla.autopilot.key');
        if (!key) {
          key = crypto.randomBytes(32).toString('hex');
          await context.secrets.store('flotilla.autopilot.key', key);
        }
        return key;
      })()),
  });
  context.subscriptions.push(
    autopilot,
    leader.start(() => {
      updateCiReads();
      void autopilot.tick();
      void reviews.resumePaused();
      void finished.sweep();
      void shared.sweep();
      void mainSync.check();
    }),
    vscode.commands.registerCommand('flotilla.hideWorktrees', () => hideWorktrees()),
    vscode.commands.registerCommand('flotilla.toggleAutopilot', async () => {
      const on = !autopilot.enabled;
      await autopilot.setEnabled(on);
      if (on) {
        void vscode.window.showInformationMessage(
          `Autopilot on: up to ${autopilot.view().max} agents take To Do tickets from the top of the backlog and work on them without a window. They report in the tickets; their work goes on to review.`,
        );
      }
    }),
  );
  ctx.clashOf = (id) => autopilot.clashOf(id);
  sidebar.useAutopilot(autopilot);
  // A repository on a slow drive is said so once, and packed in the background when it has too many loose objects.
  const storage = new StorageMonitor({ mainRoot: location.mainRoot, commonDir: location.commonDir, backlog, globalState: context.globalState, output });
  context.subscriptions.push(
    storage,
    vscode.commands.registerCommand('flotilla.slowStorageHelp', () => vscode.env.openExternal(vscode.Uri.parse(SLOW_STORAGE_DOCS))),
  );
  sidebar.useStorage(storage);
  void storage.start();
  sidebar.useQueue(reviews);
  // Other windows ask this one to select chats that run here (Open Chat on an active chat, from their side).
  const requests = setInterval(() => void chatUi.handleWindowRequests(chatContext(ctx)).catch(() => undefined), 1000);
  context.subscriptions.push({ dispose: () => clearInterval(requests) });
  // The commit check reads its mode from a file next to the hook: a changed setting goes there (once it's set up).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flotilla.ci.notify')) updateCiReads();
      if (e.affectsConfiguration('flotilla.backlog.agentTickets')) void inbox.writeGuide();
      if (!e.affectsConfiguration('flotilla.backlog.commitPrefix')) return;
      if (fs.existsSync(path.join(location.commonDir, 'flotilla', 'commit-prefix'))) {
        void installCommitHook(location.mainRoot, location.commonDir, commitPrefixMode()).catch(() => undefined);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('flotilla.showJobLog', (arg?: unknown) => showJobLog(arg, jobLogs)),
    vscode.commands.registerCommand('flotilla.showSidebar', () => vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)),
    vscode.commands.registerCommand('flotilla.showNeedsYou', () => needs.showList()),
    vscode.commands.registerCommand('flotilla.showOverview', () => sidebar.showTool('overview')),
    vscode.commands.registerCommand('flotilla.showBacklog', () => sidebar.showTool('backlog')),
    vscode.commands.registerCommand('flotilla.foldAll', () => sidebar.fold(true)),
    vscode.commands.registerCommand('flotilla.unfoldAll', () => sidebar.fold(false)),
    vscode.commands.registerCommand('flotilla.addBacklogItem', async () => {
      await sidebar.showTool('backlog');
      await newBacklogItem(backlog, integrations);
    }),
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
    repository.onDidChange(() => void chatUi.upgradeHooks(chats)),
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
      const ws = findWorkstreamFor(repository.current, doc.uri.fsPath);
      if (ws) void repository.refresh(new Set([ws.key]));
    }),
  );

  // Heartbeat: tells other windows (in any environment) that this worktree is open.
  heartbeatGitDir = location.gitDir;
  const env = envFromRemoteName(vscode.env.remoteName);
  const beat = () => writeHeartbeat(location.gitDir, env).catch((e: unknown) => output.appendLine(`Heartbeat failed: ${String(e)}`));
  void beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });

  // Refresh triggers: watchers (unreliable on bind mounts), focus, polling, settings. A change names the worktree it's
  // in (the main worktree's admin dir is the common dir), so only that one is rebuilt. Polling and focus rebuild the
  // worktrees that are due (see refreshPlan.ts); a settings change or a worktree added or removed rebuilds all.
  const scheduled: Scope = new Set();
  const refreshDue = () => void repository.refresh(scheduled);
  const scopeOf = (file: string) => scopeForChange(file, location.commonDir);
  const watched: Array<[string, string, (file: string) => Scope]> = [
    [path.join(location.commonDir, 'worktrees'), '**', scopeOf],
    // The main worktree's index and HEAD log: staging and committing there.
    [location.commonDir, '{HEAD,index,logs/HEAD,workstream.json,flotilla/**}', scopeOf],
    [path.join(location.mainRoot, '.worktrees'), '*', () => 'all'],
  ];
  for (const [base, glob, scopeOf] of watched) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(toWorkspaceUri(folder.uri, base), glob));
    const onEvent = (uri: vscode.Uri) => {
      // Heartbeats (and their temp files) change every 30 s in every window; they must not trigger refreshes.
      if (!isHeartbeatPath(uri.path)) void repository.refresh(scopeOf(uri.fsPath));
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
    pollTimer = setInterval(refreshDue, Math.max(5, seconds) * 1000);
  };
  schedulePoll();
  context.subscriptions.push(
    sidebar.onDidChangeVisibility((visible) => {
      schedulePoll();
      if (visible) refreshDue();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refreshDue();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flotilla')) {
        schedulePoll();
        void repository.refresh();
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
