import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GIT_SCHEME, GitFileSystemProvider } from './core/diff/gitContentProvider';
import {
  getGitVersion,
  GitError,
  MIN_GIT_VERSION,
  runGit,
  versionAtLeast,
} from './core/git/gitCli';
import { locateRepo } from './core/repoLocator';
import { Repository, type Scope } from './core/repository';
import { inBackground } from './core/git/gitQueue';
import { toWorkspaceUri } from './core/uris';
import type { Fetch } from './features/backlog/sources/source';
import {
  JOB_LOG_SCHEME,
  JobLogProvider,
  signedInActions,
  signedInPullRequests,
} from './features/ci/jobLog';
import { CiNotifier } from './ui/ci/ciNotifier';
import {
  deleteHeartbeat,
  envFromRemoteName,
  HEARTBEAT_INTERVAL_MS,
  isHeartbeatPath,
  writeHeartbeat,
} from './features/workstreams/heartbeat';
import { scopeForChange } from './features/workstreams/refreshPlan';
import { buildWorkstreams, findWorkstreamFor, type Workstream } from './features/workstreams/workstream';
import { WorktreeService } from './features/worktrees/worktreeService';
import { samePath, toGitPath } from './core/paths';
import * as chatUi from './ui/chatCommands';
import { registerTranscriptView } from './ui/transcriptView';
import {
  chatContext,
  type CommandContext,
  commitPrefixMode,
  openWorktree,
  prepareItemWorktree,
  registerCommands,
  removeWorkstream,
  resumePendingActions,
} from './ui/commands';
import { Autopilot } from './ui/backlog/autopilot';
import { Leader } from './features/backlog/leader';
import { ImprovementReview } from './ui/metrics/improvementReview';
import { BranchPush } from './ui/backlog/branchPush';
import { PullRequestComments } from './ui/backlog/prComments';
import { MainSync } from './ui/backlog/mainSync';
import { TicketChecker } from './ui/backlog/ticketCheck';
import { installCommitHook } from './features/backlog/commitHook';
import { writeChecksConfig } from './features/backlog/checksConfig';
import { BacklogInbox } from './ui/backlog/inboxWatcher';
import { NoteAgents, noteCommands } from './ui/backlog/notes';
import { NoteStore } from './features/backlog/notes';
import { ReviewLoop } from './ui/backlog/reviewLoop';
import { Merger } from './ui/backlog/merge';
import { BigChats } from './ui/bigChats';
import { isWorkingHere, setAgentDirs, trackTerminals } from './ui/backlog/agentRunner';
import { Shaping } from './ui/backlog/shaping';
import { AskAgent } from './ui/backlog/askAgent';
import { PauseAll } from './ui/backlog/pauseAll';
import { PausedAllStore } from './features/backlog/pausedAll';
import { commit, scmContext } from './ui/scmCommands';
import { ActiveWorktree } from './ui/activeWorktree';
import {
  activeWorktreeCommands,
  offerActivityBar,
  offerWorktreeTerminals,
  TERMINAL_PROFILE_ID,
  usesWorktreeTerminals,
  worktreeTerminalOptions,
} from './ui/activeWorktreeCommands';
import { workstreamLabel } from './ui/format';
import { registerFileCommands } from './ui/sidebar/fileCommands';
import { LocalBacklog } from './features/backlog/localBacklog';
import { BacklogIntegrations } from './ui/backlog/integrations';
import { TicketPanels } from './ui/backlog/ticketPanel';
import { Merges } from './ui/backlog/merges';
import { RunApprovals, RunTerminals } from './ui/backlog/runBlock';
import { SidebarProvider } from './ui/sidebar/sidebarProvider';
import { Metrics } from './ui/metrics/metrics';
import { devGitHubApi } from './ui/ci/devGitHub';
import { ExplorerDecorations } from './ui/explorerDecorations';
import { NeedsYouNotifier } from './ui/notifications';
import { readSettings } from './ui/settings';
import { resolveBase } from './features/workstreams/progress';
import { localBase } from './features/backlog/merge';
import { hygieneCommands } from './ui/hygiene';
import { WorkstreamStatusBar } from './ui/statusBar';
import { StorageMonitor } from './ui/storage';
import { FinishedWorktrees } from './ui/finishedWorktrees';
import { SharedFolders } from './ui/sharedFolders';
import { extraWorkspaceFolder } from './ui/workspaceFolders';
import { watchInstalledVersion } from './ui/installedVersion';
import { registerSelfUpdate, resumeAfterInstall, watchMainBuild } from './ui/selfUpdate';
import { creatingDir, creatingWorktrees } from './features/backlog/creatingWorktrees';
import { startEventLog } from './ui/eventLog';
import { registerAll } from './ui/commandSet';
import { mergeCommands } from './ui/backlog/mergeCommands';
import { agentCommands } from './ui/backlog/agentCommands';
import { autopilotCommands } from './ui/backlog/autopilotCommands';
import { metricsCommands } from './ui/metrics/metricsCommands';
import { viewCommands } from './ui/sidebar/viewCommands';

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
  // The build's commit, and in Flotilla's own repository what main has merged since (BL-151).
  registerSelfUpdate(context);
  context.subscriptions.push(
    output,
    vscode.workspace.registerFileSystemProvider(GIT_SCHEME, new GitFileSystemProvider(), { isReadonly: true, isCaseSensitive: true }),
  );
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
  watchMainBuild(context, location.mainRoot, location.commonDir, async () => {
    const base = await resolveBase(location.mainRoot, readSettings().defaultBase);
    return base && localBase(location.mainRoot, base);
  });
  // Agents reach their tickets from their worktrees, whatever Claude Code's settings block outside them (BL-89).
  setAgentDirs([backlog.dir]);
  const integrations = new BacklogIntegrations(backlog, context.secrets, location.mainRoot);
  context.subscriptions.push(integrations);
  void integrations.refresh();
  // A cancelled pick still opens a terminal (VS Code expects one): in this window's folder.
  terminalOptions = async () => (await worktreeTerminalOptions(repository, active, location.worktreeRoot, false)) ?? { cwd: location.worktreeRoot };
  // The Metrics view (BL-158): the sidebar's tool and its editor tab, counted from the event log.
  const metrics = new Metrics(context.extensionUri, location.commonDir, backlog, (session, cwd) => {
    // In the worktree it ran in; one that's gone (a merge's) in the main one's.
    const ws = (cwd && repository.current.find((w) => w.worktree.path && samePath(w.worktree.path, cwd))) || repository.current.find((w) => w.worktree.isMain);
    if (ws) void vscode.commands.executeCommand('flotilla.openChat', { key: ws.key, chatId: session });
  });
  context.subscriptions.push(metrics);
  const sidebar = new SidebarProvider({
    metrics,
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
  const merger = new Merger({
    backlog,
    repository,
    mainRoot: location.mainRoot,
    // The checks' logs go to .git/flotilla/merges/<id>/ (BL-169).
    commonDir: location.commonDir,
    output,
    openTicket: (id) => void tickets.open(id),
    // Merge to main decides on CI's result when there is one (BL-105).
    ciReader: () => sidebar.ci.originActions(location.mainRoot),
    updateFromMain: (id) => mainSync.update(id),
    agentWorking: (id) => reviews.isRunning(id),
    fixCi: (branch, runId, jobId, runBranch) => sidebar.ci.fixOnOrigin(location.mainRoot, branch, runId, jobId, runBranch),
    // One window rebuilds the merge train (BL-140); the others read it from backlog.json.
    isLeader: () => leader.isLeader,
    // Whether you let the merge train be pushed for CI (BL-145), asked once.
    state: context.workspaceState,
  });
  // Whether the items' work is merged, read from git: refreshed with the repository (refs move, polling) and the backlog.
  const merges = new Merges({ backlog, mainRoot: location.mainRoot, merging: (id) => merger.isFinishing(id) });
  sidebar.useMerges(merges);
  sidebar.useMerger(merger);
  context.subscriptions.push(
    repository.onDidChange(() => void merges.refresh()),
    backlog.watch(() => void merges.refresh()),
    // The merge queue's train is rebuilt when main, a queued branch or the queue moves.
    repository.onDidChange(() => merger.queueChanged()),
    backlog.watch(() => merger.queueChanged()),
  );
  // Worktrees being created are recorded in the common dir, so every window sees each other's (and doesn't make another).
  context.subscriptions.push(
    creatingWorktrees.attach(creatingDir(location.commonDir)),
    repository.onDidChange(() => creatingWorktrees.reload()),
  );
  void merges.refresh();
  const runTerminals = new RunTerminals();
  context.subscriptions.push(runTerminals);
  const tickets = new TicketPanels({
    extensionUri: context.extensionUri,
    mainRoot: service.roots.mainRoot,
    reference: folder.uri,
    backlog,
    integrations,
    repository,
    merges,
    approvals: new RunApprovals(context.workspaceState),
    terminals: runTerminals,
    revealWorktree: (key) => sidebar.reveal(key, undefined, 'files'),
    showCommits: (key, ticket, hashes, selected) => sidebar.showCommits(key, ticket, hashes, selected),
    showTicketChanges: (key, ticket, path) => sidebar.showTicketChanges(key, ticket, path),
    memento: context.globalState,
    output,
    ci: sidebar.ci,
    showCi: (key) => sidebar.showCi(key),
  });
  context.subscriptions.push(tickets);
  sidebar.useTickets(tickets);
  // One window acts on its own for the backlog (the autopilot, agents going on after a usage limit).
  const leader = new Leader(backlog.dir);
  // What happens to tickets, agents and merges, recorded as events (BL-157).
  const eventLog = startEventLog({ commonDir: location.commonDir, mainRoot: location.mainRoot, backlog, isLeader: () => leader.isLeader, output });
  context.subscriptions.push(eventLog);
  metrics.onView = () => eventLog.scanSoon();
  merger.queueChanged();
  // Pause All's record (BL-160): while it's there, no agent starts on its own, in any window.
  const pausedAll = new PausedAllStore(location.commonDir);
  const reviews = new ReviewLoop({
    backlog,
    repository,
    mainRoot: location.mainRoot,
    output,
    pausedAll: () => pausedAll.held,
    isLeader: () => leader.isLeader,
    limitLifted: () => void notes.limitLifted(),
    onApproved: (id, by) => {
      pushes.approved(id);
      merger.approved(id, by);
    },
  });
  const pushes = new BranchPush({
    backlog,
    repository,
    mainRoot: location.mainRoot,
    isLeader: () => leader.isLeader,
    output,
    localOnly: devGitHubApi(context.extensionMode) !== undefined,
    pullRequests: signedInPullRequests(globalThis.fetch as unknown as Fetch, devGitHubApi(context.extensionMode)),
    baseBranch: () => merger.baseBranch(),
  });
  // The tickets' comments and their pull requests', both ways (BL-224).
  const prComments = new PullRequestComments({
    backlog,
    mainRoot: location.mainRoot,
    isLeader: () => leader.isLeader,
    output,
    pullRequests: signedInPullRequests(globalThis.fetch as unknown as Fetch, devGitHubApi(context.extensionMode)),
    shown: () => tickets.shownIds(),
  });
  context.subscriptions.push(
    prComments,
    sidebar.ci.onDidChange(() => prComments.ciRead()),
    // A link back from a comment posted on GitHub opens its ticket at its entry.
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        const q = new URLSearchParams(uri.query);
        const id = q.get('id');
        if (uri.path === '/ticket' && id) void tickets.openReference({ id, ...(q.get('entry') ? { anchor: q.get('entry')! } : {}) });
      },
    }),
  );
  context.subscriptions.push(reviews, merger, pushes, trackTerminals());
  registerAll(context.subscriptions, mergeCommands({ backlog, merger }));
  // Descriptions edited in the ticket files (by agents, in editors) are noted in their tickets.
  const noteDescriptions = () => void backlog.noteDescriptions().catch((e: unknown) => output.appendLine(`Noting description edits: ${String(e)}`));
  context.subscriptions.push(backlog.watch(() => noteDescriptions()));
  noteDescriptions();
  tickets.useReviews(reviews);
  tickets.useMerger(merger);
  // Check (BL-163): what a ticket says is going on, against what runs; Clean Up of what doesn't.
  const checker = new TicketChecker({
    backlog,
    repository,
    reviews,
    merger,
    mainRoot: location.mainRoot,
    runsHere: isWorkingHere,
    get staleMinutes() {
      return readSettings().agentStatusStaleMinutes;
    },
    creating: { dir: creatingDir(location.commonDir), cleared: () => creatingWorktrees.reload() },
  });
  tickets.useChecker(checker);
  // Open tickets' branches checked against main when either moves (BL-55); Update from Main in the ticket.
  const mainSync = new MainSync({ backlog, repository, reviews, mainRoot: location.mainRoot, isLeader: () => leader.isLeader, output });
  context.subscriptions.push(mainSync);
  tickets.useMainSync(mainSync);
  // Tickets nobody works on yet are talked through with an agent in a chat (BL-188); Discuss opens that.
  const mainWorkstream = () => repository.current.find((w) => w.worktree.isMain);
  const shaping = new Shaping({
    backlog,
    repository,
    mainRoot: location.mainRoot,
    output,
    newChat: async (lead, task) => {
      const main = mainWorkstream();
      if (main) await chatUi.newChat(chatContext(ctx), main, task, lead, { beside: true });
    },
    openChat: async (key, chatId) => void (await vscode.commands.executeCommand('flotilla.openChat', { key, chatId })),
  });
  context.subscriptions.push(shaping);
  tickets.useShaping(shaping);
  const answers = new AskAgent({
    backlog,
    repository,
    mainRoot: location.mainRoot,
    output,
    reviews,
    isOpen: (id) => tickets.isOpen(id),
    open: (id) => tickets.open(id),
  });
  context.subscriptions.push(answers);
  tickets.useAnswers(answers);
  // Notes (BL-182): requests jotted down in the backlog, which an agent turns into ticket proposals.
  const noteStore = new NoteStore(backlog.dir);
  const inbox = new BacklogInbox(backlog, integrations, repository, { mainRoot: location.mainRoot, commonDir: location.commonDir }, noteStore);
  context.subscriptions.push(inbox);
  const notes = new NoteAgents({
    extensionUri: context.extensionUri,
    notes: noteStore,
    backlog,
    repository,
    mainRoot: location.mainRoot,
    output,
    isLeader: () => leader.isLeader,
    admit: (id) => reviews.admitNew(id),
    giveBack: (slot) => reviews.giveBack(slot),
    pausedAll: () => pausedAll.held,
  });
  // A run ended: a due note's agent takes the freed slot at once, not on its 5 s timer (BL-220).
  context.subscriptions.push(
    notes,
    reviews.onDidChangeAgents(() => void notes.tick()),
  );
  registerAll(context.subscriptions, noteCommands(notes));
  sidebar.useNotes(notes);
  const pauseAll = new PauseAll({
    backlog,
    reviews,
    shaping,
    merges: merger,
    notes,
    store: pausedAll,
    lifted: () => (reviews.dispatchQueued(), void notes.tick()),
  });
  context.subscriptions.push(pauseAll);
  // After Install Main's reload (BL-161): the agents it paused go on.
  resumeAfterInstall(context, location.commonDir, pauseAll);
  registerAll(context.subscriptions, agentCommands({ backlog, tickets, reviews, shaping, checker }));
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
    notes,
    leader,
    openTicket: (id) => void tickets.open(id),
    openNote: (id) => void notes.openNote(id, true),
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
  context.subscriptions.push(finished);
  // Worktrees' copies of flotilla.linkFolders share the main worktree's files, made before the setting or not.
  const shared = new SharedFolders({ repository, leader, mainRoot: location.mainRoot, workspaceState: context.workspaceState, output });
  context.subscriptions.push(shared);
  registerAll(context.subscriptions, hygieneCommands({ finished, shared }));
  // One of the user's chats grew big: once, a word on what that costs (BL-70).
  context.subscriptions.push(new BigChats({ repository, leader, globalState: context.globalState }));
  let autopilotKey: Promise<string> | undefined;
  const autopilot = new Autopilot({
    backlog,
    repository,
    reviews,
    leader,
    output,
    pauseAll,
    merges: merger,
    prepareWorktree: (item) => prepareItemWorktree(ctx, item),
    // A note due: the autopilot leaves the slot to its agent, which looks now (BL-220).
    noteDue: async () => {
      const id = await notes.due();
      if (id) void notes.tick();
      return id;
    },
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
  // Once a week, an agent reads the metrics and proposes tickets (BL-159).
  const improvement = new ImprovementReview({
    backlog,
    repository,
    admit: (id) => reviews.admitNew(id),
    giveBack: (slot) => reviews.giveBack(slot),
    autopilot: () => autopilot.view(),
    isLeader: () => leader.isLeader,
    commonDir: location.commonDir,
    mainRoot: location.mainRoot,
    output,
  });
  context.subscriptions.push(improvement);
  registerAll(context.subscriptions, metricsCommands({ backlog, repository, metrics, improvement, output }));
  context.subscriptions.push(
    autopilot,
    leader.start(() => {
      updateCiReads();
      void autopilot.tick();
      void notes.tick();
      void improvement.tick().catch(() => undefined);
      void reviews.resumePaused();
      void finished.sweep();
      void shared.sweep();
      void mainSync.check();
    }),
  );
  registerAll(context.subscriptions, autopilotCommands({ autopilot, pauseAll }));
  ctx.clashOf = (id) => autopilot.clashOf(id);
  ctx.startWork = (item, ws) => reviews.startWork(item, ws, { byHand: true });
  sidebar.useAutopilot(autopilot);
  // A repository on a slow drive is said so once, and packed in the background when it has too many loose objects.
  const storage = new StorageMonitor({ mainRoot: location.mainRoot, commonDir: location.commonDir, backlog, globalState: context.globalState, output });
  context.subscriptions.push(storage);
  sidebar.useStorage(storage);
  void storage.start();
  sidebar.useQueue(reviews);
  // Other windows ask this one to select chats that run here (Open Chat on an active chat, from their side).
  context.subscriptions.push(registerTranscriptView());
  const requests = setInterval(() => void chatUi.handleWindowRequests(chatContext(ctx)).catch(() => undefined), 1000);
  context.subscriptions.push({ dispose: () => clearInterval(requests) });
  // Test scripts that queue for the machine (scripts/test.mjs) read how many runs go at once from .git/flotilla.
  const updateChecksConfig = () =>
    void writeChecksConfig(location.commonDir, vscode.workspace.getConfiguration('flotilla').get<number>('checks.maxParallel', 0)).catch(() => undefined);
  updateChecksConfig();
  // The commit check reads its mode from a file next to the hook: a changed setting goes there (once it's set up).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flotilla.checks.maxParallel')) updateChecksConfig();
      if (e.affectsConfiguration('flotilla.ci.notify')) updateCiReads();
      if (e.affectsConfiguration('flotilla.backlog.agentTickets')) void inbox.writeGuide();
      if (!e.affectsConfiguration('flotilla.backlog.commitPrefix')) return;
      if (fs.existsSync(path.join(location.commonDir, 'flotilla', 'commit-prefix'))) {
        void installCommitHook(location.mainRoot, location.commonDir, commitPrefixMode()).catch(() => undefined);
      }
    }),
  );
  registerAll(context.subscriptions, viewCommands({ sidebar, needs, jobLogs, backlog, integrations }));
  registerAll(
    context.subscriptions,
    activeWorktreeCommands({ extension: context, repository, active, currentRoot: location.worktreeRoot, reference: folder.uri }),
  );
  void offerActivityBar(context, false);
  context.subscriptions.push(offerWorktreeTerminals(context, repository, active));
  // With + opening terminals in the active worktree, the terminal panel's own worktree button is hidden.
  const updateTerminalContext = () => void vscode.commands.executeCommand('setContext', 'flotilla.worktreeTerminals', usesWorktreeTerminals());
  updateTerminalContext();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('terminal.integrated') && updateTerminalContext()));
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
      void chatUi
        .removeCopiedChats(chats)
        .then(() => chatUi.tagLinkedChatTitles(chats))
        .catch(report);
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
      // Nor do the events recorded (BL-157): they're written as things happen.
      if (!isHeartbeatPath(uri.path) && !uri.path.includes('/flotilla/metrics/')) void repository.refresh(scopeOf(uri.fsPath));
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
