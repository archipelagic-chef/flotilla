import * as path from 'node:path';
import * as vscode from 'vscode';
import { openChangeDiff, openChangesEditor } from '../core/diff/openDiff';
import { INDEX, WORKING } from '../core/diff/refs';
import { GitError } from '../core/git/gitCli';
import { isInside, resolveInside, samePath } from '../core/paths';
import type { Repository } from '../core/repository';
import { toWorkspaceUri } from '../core/uris';
import {
  addBranch,
  agentChatItem,
  agentLead,
  agentName,
  type BacklogItem,
  type BacklogStatus,
  branchFor,
  branchMatches,
  discardItem,
  itemBranches,
  linkIssue,
  removeItem,
  reopenItem,
  setStartFailed,
  updateItem,
} from '../features/backlog/backlog';
import { tidyNotes } from '../features/backlog/tidyNotes';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import { KEEP_WHEN_DONE } from '../features/backlog/descriptionShape';
import type { RemoteIssue } from '../features/backlog/sources/source';
import type { BacklogIntegrations } from './backlog/integrations';
import type { TicketPanels } from './backlog/ticketPanel';
import {
  cancelCleanUp,
  type CleanUpDeps,
  compareCleanUp,
  finishCleanUp,
  startCleanUp,
} from './backlog/historyCleanup';
import { compareWithBase, type CompareMode } from '../features/diffs/compare';
import { resolveBase } from '../features/workstreams/progress';
import { installCommitHook, markWorktree, type CommitPrefixMode } from '../features/backlog/commitHook';
import { GUIDE } from '../features/backlog/inbox';
import { entryDate } from '../features/backlog/ticket';
import { creatingWorktrees } from '../features/backlog/creatingWorktrees';
import { removingWorktrees } from '../features/workstreams/removingWorktrees';
import {
  type Clash,
  clashFiles,
  type CodeMap,
  mapFor,
  mapNote,
} from '../features/backlog/codeMap';
import { CONTEXT_NOTES, epicNote, reviewNotes } from '../features/backlog/review';
import { failureTask, fixRefusal, parseFailedJob } from '../features/ci/failureTask';
import { REPORT_FORMAT } from '../features/backlog/report';
import {
  agentChoice,
  confirmMemory,
  describeChoice,
  levelNote,
} from './backlog/agentRunner';
import { envFromRemoteName } from '../features/workstreams/heartbeat';
import type { Workstream } from '../features/workstreams/workstream';
import type { ResolvedWorktree } from '../features/worktrees/resolver';
import { branchNameProblem } from '../features/worktrees/layout';
import { copySetupFiles, linkFolders } from '../features/worktrees/setup';
import type { BranchList, CreateRequest, WorktreeService } from '../features/worktrees/worktreeService';
import type { ChangeGroup, VcFileDiff } from '../webview/protocol';
import { vcFileDiffOf } from '../webview/vcFile';
import { backlogIdOf, linkedWorktrees } from './backlog/cardMenu';
import { branchPickEntries, type BranchPickAction } from './branchPicker';
import * as chatUi from './chatCommands';
import {
  type Arg,
  type Commands,
  type Handler,
  isTarget,
  joinCommands,
  type PickFilter,
  registerAll,
  type WithWorkstream,
} from './commandSet';
import { describeWorkstream, workstreamLabel } from './format';
import { maybeOfferHygiene } from './hygiene';
import { removalToRun, type PendingRemoval } from './pending';
import {
  discardDetail,
  discardEntry,
  noteDependents,
  reopenEntry,
} from '../features/backlog/discard';
import * as scmUi from './scmCommands';
import { readSettings } from './settings';
import { runWorkflowByHand } from './ci/runWorkflow';
import { devGitHubApi } from './ci/devGitHub';
import { addWorkspaceFolder, extraWorkspaceFolder, removeWorkspaceFolder } from './workspaceFolders';

/** What the sidebar offers to commands. */
export interface SidebarHandle {
  reveal(key: string): void;
  /** Shows a worktree's file in the sidebar's Files tool, its folders expanded and it selected. */
  revealInFiles(key: string, path: string): void;
  /** Opens a Version Control file row's diff, as clicking the row does. */
  openDiff(diff: VcFileDiff): Promise<void>;
}

export interface CommandContext {
  extension: vscode.ExtensionContext;
  service: WorktreeService;
  repository: Repository<Workstream>;
  sidebar: SidebarHandle;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  /** Root of the worktree open in this window. */
  currentRoot: string;
  /** Git dir of that worktree. */
  currentGitDir: string;
  /** Key of the sidebar's active worktree, or 'all'. Commands without a target act on it. */
  activeKey(): string;
  output: vscode.OutputChannel;
  backlog: LocalBacklog;
  tickets: TicketPanels;
  integrations: BacklogIntegrations;
  /** Why the autopilot holds a To Do ticket back (BL-71), if it does: a start by hand says so. Set once it's made. */
  clashOf?(id: string): Clash | undefined;
  /** Starts an agent on an item's work without a window, through the agent queue (the review loop's). Set once it's made. */
  startWork?(item: BacklogItem, ws: Workstream): Promise<void>;
}

const PENDING_REMOVAL_KEY = 'flotilla.pendingRemoval';

export async function openWorktree(ctx: CommandContext, dir: string, newWindow: boolean): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', toWorkspaceUri(ctx.reference, dir), { forceNewWindow: newWindow });
}

export function chatContext(ctx: CommandContext): chatUi.ChatContext {
  return {
    extension: ctx.extension,
    currentRoot: ctx.currentRoot,
    currentGitDir: ctx.currentGitDir,
    mainRoot: ctx.service.roots.mainRoot,
    commonDir: ctx.service.roots.commonDir,
    workstreams: () => ctx.repository.current,
    refresh: () => ctx.repository.refresh(),
    output: ctx.output,
    focusWindow: (dir) => openWorktree(ctx, dir, true),
    env: envFromRemoteName(vscode.env.remoteName),
  };
}

export function registerCommands(ctx: CommandContext): void {
  const withWs: WithWorkstream =
    (handler, filter = {}) =>
    async (arg?: Arg) => {
      const ws = await pickWorkstream(ctx, arg, filter);
      if (ws) await handler(ws, arg);
    };
  const chats = chatContext(ctx);
  const commands = joinCommands(
    worktreeCommands(ctx, withWs),
    backlogCommands(ctx, chats),
    ciCommands(ctx),
    scmUi.scmCommands(scmUi.scmContext(ctx.repository), withWs),
    chatUi.chatCommands(chats, withWs),
  );
  registerAll(ctx.extension.subscriptions, commands, (handler) => guard(ctx, handler));
}

/** The worktrees' commands: make, switch, remove, and what's in them. */
function worktreeCommands(ctx: CommandContext, withWs: WithWorkstream): Commands {
  return {
    'flotilla.refresh': () => ctx.repository.refresh(),
    'flotilla.newWorkstream': () => newWorkstream(ctx),
    'flotilla.quickSwitch': () => quickSwitch(ctx),
    'flotilla.openInNewWindow': withWs((ws) => openWorktree(ctx, ws.worktree.path!, true)),
    'flotilla.switchHere': withWs((ws) => openWorktree(ctx, ws.worktree.path!, false)),
    'flotilla.remove': withWs((ws) => removeWorkstream(ctx, ws), { includeUnreachable: true, excludeMain: true }),
    'flotilla.adopt': withWs(
      async (ws) => {
        await ctx.service.adopt(ws.worktree);
        void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
        await ctx.repository.refresh();
      },
      { excludeMain: true },
    ),
    'flotilla.runSetupHere': withWs((ws) => runSetupNow(ctx, ws.worktree.path!), { excludeMain: true }),
    'flotilla.openTerminal': withWs((ws) => vscode.window.createTerminal({ name: workstreamLabel(ws), cwd: ws.worktree.path }).show()),
    'flotilla.copyPath': withWs((ws, arg) => vscode.env.clipboard.writeText(resolveInside(ws.worktree.path!, (isTarget(arg) && arg.path) || ''))),
    'flotilla.revealInOS': withWs((ws) => vscode.commands.executeCommand('revealFileInOS', toWorkspaceUri(ctx.reference, ws.worktree.path!))),
    'flotilla.compareWith': withWs((ws) => compareWith(ctx, ws)),
    'flotilla.openFile': withWs((ws, arg) => openFile(ctx, ws, isTarget(arg) ? arg.path : undefined)),
    'flotilla.openFileDiff': withWs((ws, arg) => isTarget(arg) && arg.path && openFileDiff(ctx, ws, arg.path, arg.group ?? 'unstaged')),
    'flotilla.openChanges': withWs((ws, arg) => openGroupChanges(ctx, ws, (isTarget(arg) && arg.group) || 'unstaged')),
    'flotilla.addToWorkspace': withWs(
      (ws) => {
        if (ws.isCurrent) return vscode.window.showInformationMessage(`'${workstreamLabel(ws)}' is already this window's folder.`);
        addWorkspaceFolder(ctx.reference, ws.worktree.path!, `⎇ ${workstreamLabel(ws)}`);
      },
      { excludeMain: true },
    ),
    'flotilla.removeFromWorkspace': withWs((ws) => removeWorkspaceFolder(ws.worktree.path)),
    'flotilla.revealInExplorer': (arg?: Arg) => revealInExplorer(ctx, arg),
    'flotilla.openVcFileChanges': (arg?: unknown) => openVcFileChanges(ctx, arg),
    'flotilla.revealInFiles': (arg?: Arg) => isTarget(arg) && arg.path && ctx.sidebar.revealInFiles(arg.key, arg.path),
  };
}

/** The backlog's commands on a ticket: start it, its worktrees, its review, its history's clean-up. */
function backlogCommands(ctx: CommandContext, chats: chatUi.ChatContext): Commands {
  const cleanUp: CleanUpDeps = {
    ctx,
    chats,
    createWorkstream: (request) => createWorkstream(ctx, request),
    enforceCommitPrefix: (ws, id) => enforceCommitPrefix(ctx, ws, id),
  };
  return {
    'flotilla.startBacklogItem': (id?: unknown, opts?: unknown) => startBacklogItem(ctx, backlogIdOf(id), opts),
    'flotilla.backlogIntegrations': () => ctx.integrations.manage(),
    'flotilla.planBacklog': () => planBacklog(ctx),
    'flotilla.linkBacklogItem': (id?: unknown) => linkBacklogItem(ctx, backlogIdOf(id)),
    // The backlog card's context menu (package.json, webviewSection backlogItem) passes its card, not an id.
    'flotilla.startBacklogItemFromCard': (card?: unknown) => startBacklogItem(ctx, backlogIdOf(card), { agent: true }),
    // Create Worktree, as the ticket's button: at once, or with the branch named first (the card, its menu, the ticket).
    'flotilla.createBacklogWorktree': (card?: unknown) => startBacklogItem(ctx, backlogIdOf(card), { agent: false, newWorktree: 'auto' }),
    'flotilla.createBacklogWorktreeNamed': (card?: unknown) => startBacklogItem(ctx, backlogIdOf(card), { agent: false, newWorktree: 'named' }),
    'flotilla.renameBacklogItem': (card?: unknown) => renameBacklogItem(ctx, backlogIdOf(card)),
    'flotilla.deleteBacklogItem': (card?: unknown) => deleteBacklogItem(ctx, backlogIdOf(card)),
    'flotilla.discardBacklogItem': (card?: unknown) => discardBacklogItem(ctx, backlogIdOf(card)),
    'flotilla.reopenBacklogItem': (card?: unknown, status?: BacklogStatus) => reopenBacklogItem(ctx, backlogIdOf(card), status),
    'flotilla.selectBacklogWorktree': (card?: unknown) => selectBacklogWorktree(ctx, backlogIdOf(card), false),
    'flotilla.openBacklogWorktreeInNewWindow': (card?: unknown) => selectBacklogWorktree(ctx, backlogIdOf(card), true),
    'flotilla.cleanUpHistory': (id?: unknown, opts?: unknown) => startCleanUp(cleanUp, id, opts),
    'flotilla.finishCleanUp': (id?: unknown, opts?: unknown) => finishCleanUp(cleanUp, id, opts),
    'flotilla.cancelCleanUp': (id?: unknown) => cancelCleanUp(cleanUp, id),
    'flotilla.compareCleanUp': (id?: unknown) => compareCleanUp(cleanUp, id),
    'flotilla.reviewBacklogItem': (id?: unknown, verdict?: unknown, text?: unknown) =>
      ctx.tickets.review(
        typeof id === 'string' ? id : undefined,
        verdict === 'approved' || verdict === 'changes' ? verdict : undefined,
        typeof text === 'string' ? text : undefined,
      ),
    'flotilla.openBacklogItem': (id?: unknown, opts?: unknown) => {
      const itemId = backlogIdOf(id);
      const focus = (opts as { focus?: unknown } | undefined)?.focus;
      return itemId && ctx.tickets.open(itemId, { focus: focus === 'comment' || focus === 'demo' ? focus : undefined });
    },
  };
}

/** CI's commands: a workflow run by hand, and an agent on a failed job. */
function ciCommands(ctx: CommandContext): Commands {
  return {
    'flotilla.runWorkflow': () => runWorkflowByHand(ctx.currentRoot, devGitHubApi(ctx.extension.extensionMode)),
    // A failed CI job (from the CI/CD view or its notice): an agent fixes it in the worktree on its branch.
    'flotilla.ci.fixWithAgent': (failure?: unknown) => fixWithAgent(ctx, failure),
  };
}

export async function resumePendingActions(ctx: CommandContext): Promise<void> {
  const state = ctx.extension.globalState;
  const now = Date.now();
  const removal = removalToRun(state.get<PendingRemoval>(PENDING_REMOVAL_KEY), ctx.service.roots.mainRoot, ctx.currentRoot, now);
  if (removal.clear) await state.update(PENDING_REMOVAL_KEY, undefined);
  const plan = removal.run;
  if (plan) await guard(ctx, () => executeRemoval(ctx, plan))();
}

function guard(ctx: CommandContext, handler: Handler): Handler {
  return async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      await reportError(ctx, error);
    }
  };
}

async function reportError(ctx: CommandContext, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  ctx.output.appendLine(message);
  const checkedOut = error instanceof GitError ? /(?:already checked out|is already used by worktree) at '([^']+)'/.exec(error.stderr) : null;
  if (checkedOut) {
    const choice = await vscode.window.showErrorMessage(`That branch is already checked out in ${checkedOut[1]}.`, 'Open That Worktree');
    if (choice) await openWorktree(ctx, checkedOut[1], true);
    return;
  }
  const choice = await vscode.window.showErrorMessage(message, 'Show Output');
  if (choice) ctx.output.show();
}

async function pickWorkstream(ctx: CommandContext, arg: Arg, filter: PickFilter): Promise<Workstream | undefined> {
  // From the Explorer: the worktree folder that was right-clicked.
  if (arg instanceof vscode.Uri) {
    const ws = ctx.repository.current.find((w) => w.worktree.path && samePath(w.worktree.path, arg.fsPath));
    if (ws) return ws;
  } else if (isTarget(arg)) {
    const ws = ctx.repository.current.find((w) => w.key === arg.key);
    if (ws) return ws;
  } else if (arg === undefined) {
    // From the palette or a shortcut: the active worktree is the context, unless the All tab is selected.
    const ws = ctx.repository.current.find((w) => w.key === ctx.activeKey());
    if (ws && (filter.includeUnreachable || ws.worktree.path) && !(filter.excludeMain && ws.worktree.isMain)) return ws;
  }
  const now = new Date();
  const candidates = ctx.repository.current.filter((ws) => (filter.includeUnreachable || ws.worktree.path) && !(filter.excludeMain && ws.worktree.isMain));
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('No matching workstreams.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((ws) => ({ label: workstreamLabel(ws), description: describeWorkstream(ws, now), ws })),
    { placeHolder: 'Select a workstream' },
  );
  return picked?.ws;
}

type BranchItem = vscode.QuickPickItem & { action?: BranchPickAction };

/** One searchable picker, like VS Code's own branch picker. Resolves to the chosen action, or undefined when dismissed. */
async function pickBranchAction(
  branches: BranchList,
  checkedOut: ReadonlyMap<string, string>,
): Promise<{ action: BranchPickAction; typed: string } | undefined> {
  const quickPick = vscode.window.createQuickPick<BranchItem>();
  quickPick.title = 'New workstream';
  quickPick.placeholder = 'Select a branch for the new worktree, or type a new branch name';
  const render = () => {
    quickPick.items = branchPickEntries(quickPick.value, branches, checkedOut).map((e) =>
      e.separator
        ? { label: e.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: e.label, description: e.description, alwaysShow: e.alwaysShow, action: e.action },
    );
  };
  render();
  const result = await new Promise<{ action: BranchPickAction; typed: string } | undefined>((resolve) => {
    quickPick.onDidChangeValue(render);
    quickPick.onDidAccept(() => {
      const action = quickPick.selectedItems[0]?.action;
      if (action) resolve({ action, typed: quickPick.value.trim() });
    });
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  return result;
}

async function askBranchName(branches: BranchList, typed: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'New branch name',
    prompt: 'The worktree folder is named after the branch.',
    value: typed,
    validateInput: (value) => branchNameProblem(value.trim(), branches.local),
  });
}

async function newWorkstream(ctx: CommandContext): Promise<void> {
  const branches = await ctx.service.listBranches();
  const checkedOut = new Map<string, string>();
  for (const ws of ctx.repository.current) {
    if (ws.worktree.branch)
      checkedOut.set(ws.worktree.branch, ws.worktree.isMain ? 'the main worktree' : path.basename(ws.worktree.path ?? ws.worktree.recordedPath));
  }
  const picked = await pickBranchAction(branches, checkedOut);
  if (!picked) return;
  const { action, typed } = picked;

  let request: CreateRequest;
  switch (action.kind) {
    case 'checkedOut':
      void vscode.window.showInformationMessage(
        `'${action.branch}' is already checked out in ${action.where}. Git can't check out a branch in two worktrees at once.`,
      );
      return;
    case 'existing':
      request = { kind: 'existing', branch: action.branch };
      break;
    case 'remote':
      request = { kind: 'remote', remoteRef: action.remoteRef };
      break;
    case 'createNamed':
      request = { kind: 'new', branch: action.branch, startPoint: 'HEAD' };
      break;
    case 'createPrompt':
    case 'createFrom': {
      const branch = (await askBranchName(branches, typed))?.trim();
      if (!branch) return;
      let startPoint = 'HEAD';
      if (action.kind === 'createFrom') {
        const from = await vscode.window.showQuickPick(['HEAD', ...branches.local, ...branches.remote], { title: `Start '${branch}' from…` });
        if (!from) return;
        startPoint = from;
      }
      request = { kind: 'new', branch, startPoint };
      break;
    }
  }

  await createWorkstream(ctx, request);
}

/** Creates a worktree, copies the setup files, runs the setup command and shows it; returns its key. */
async function createWorkstream(ctx: CommandContext, request: CreateRequest, opts: { quiet?: boolean; label?: string } = {}): Promise<string> {
  // Quiet (the autopilot's): progress in the status bar, and the sidebar stays where it is.
  const created = await vscode.window.withProgress(
    {
      location: opts.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
      title: opts.label ? `Creating ${opts.label}'s worktree…` : 'Creating worktree…',
    },
    () => ctx.service.create(request),
  );
  const dir = created.path!;
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  if (copied.length) ctx.output.appendLine(`Copied into ${dir}: ${copied.join(', ')}`);
  await linkSetupFolders(ctx, dir, settings.linkFolders, opts.quiet);
  startSetupTerminal(dir, settings.setupCommand);
  await ctx.repository.refresh();
  if (!opts.quiet) ctx.sidebar.reveal(created.adminDir);
  // Hooks follow the repository: once they are installed somewhere, new worktrees get them too.
  if (ctx.repository.current.some((w) => w.hasHooks)) {
    const fresh = ctx.repository.current.find((w) => w.key === created.adminDir);
    if (fresh) await chatUi.installChatHooks(chatContext(ctx), fresh);
  }
  void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
  return created.adminDir;
}

/**
 * Starts work on a backlog item: shows the worktree whose branch carries it, or creates one (branch named by
 * flotilla.backlog.branchPattern, from the default branch), and marks the item in progress. With agent, a Claude Code
 * agent then works on it in that worktree, reporting in the item's ticket. With newWorktree (the ticket's Create Worktree
 * button), a new worktree is created at once, its branch named without asking ('auto') or in an input box ('named').
 */
async function startBacklogItem(ctx: CommandContext, id: unknown, opts?: unknown): Promise<void> {
  if (typeof id !== 'string') return;
  const agent = typeof opts === 'object' && opts !== null && (opts as { agent?: unknown }).agent === true;
  const newWorktree = typeof opts === 'object' && opts !== null ? (opts as { newWorktree?: unknown }).newWorktree : undefined;
  const found = await findBacklogItem(ctx, id);
  if (!found) return;
  const { item, remote } = found;
  // A start while its worktree is being created (a second click, the card and the ticket) would make another one.
  if (creatingWorktrees.has(item.id)) {
    void vscode.window.showInformationMessage(`${item.id}'s worktree is still being created.`);
    return;
  }
  // An agent needs memory to start: when there's little, the user decides (before a worktree is made for it).
  if (agent && !(await confirmMemory(`The agent for ${item.id}`))) return;
  // A branch of the item that has no worktree (anymore): a worktree for it.
  const branchOpt = typeof opts === 'object' && opts !== null ? (opts as { branch?: unknown }).branch : undefined;
  if (typeof branchOpt === 'string' && branchMatches(item, branchOpt)) {
    const made = await creatingWorktrees.run(item.id, () => createWorkstream(ctx, { kind: 'existing', branch: branchOpt }, { label: item.id }));
    if (made.busy) return;
    const created = ctx.repository.current.find((w) => w.key === made.value);
    if (created) await enforceCommitPrefix(ctx, created, item.id);
    if (made.value) ctx.sidebar.reveal(made.value);
    return;
  }
  const linked = linkedWorktrees(item, ctx.repository.current);
  let ws: Workstream | undefined;
  if (!linked.length || (!agent && (newWorktree === 'auto' || newWorktree === 'named'))) {
    ws = await newItemWorktree(ctx, item, newWorktree === 'named');
  } else {
    // An epic has several worktrees: start in one of them, or in a new one.
    type Pick = vscode.QuickPickItem & { ws?: Workstream };
    const now = new Date();
    const picks: Pick[] = [
      ...linked.map((w) => ({ label: `$(git-branch) ${workstreamLabel(w)}`, detail: describeWorkstream(w, now), ws: w })),
      { label: `$(add) New Worktree for ${item.id}`, detail: 'Another branch for this item, e.g. one part of an epic' },
    ];
    const picked = await vscode.window.showQuickPick(picks, {
      title: agent ? `Start an agent on ${item.id}` : `Work on ${item.id}`,
      placeHolder: 'In which worktree?',
    });
    if (!picked) return;
    ws = picked.ws ?? (await newItemWorktree(ctx, item, false));
  }
  if (!ws?.worktree.branch) return;
  const branch = ws.worktree.branch;
  await enforceCommitPrefix(ctx, ws, item.id);
  // Issues from integrations aren't in the local backlog: their branch carries their key, which links them.
  if (!remote)
    await ctx.backlog.change((d) => setStartFailed(updateItem(addBranch(d, id, branch), id, { status: item.status === 'done' ? 'done' : 'doing' }), id));
  // Held back by the autopilot for a clash (BL-71): started anyway, which the ticket and a notice say.
  const clash = !remote && item.status === 'todo' ? ctx.clashOf?.(item.id) : undefined;
  if (clash) {
    const body = `Started by hand despite the clash with ${clash.with} (in progress): both change ${clashFiles(clash)}. Its work may need redoing once ${clash.with} is merged.`;
    await ctx.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body });
    void vscode.window.showInformationMessage(
      `${item.id} started despite the clash with ${clash.with}: both change ${clash.files.slice(0, 3).join(', ')}${clash.files.length > 3 ? ', …' : ''}.`,
    );
  }
  ctx.sidebar.reveal(ws.key);
  if (agent && ws.worktree.path) await runAgent(ctx, item, ws, remote);
}

/**
 * Makes an item's worktree the sidebar's active tab, or opens it in a new window (BL-21, the card's menu). With
 * several worktrees (an epic), the user picks one.
 */
async function selectBacklogWorktree(ctx: CommandContext, id: string | undefined, newWindow: boolean): Promise<void> {
  if (!id) return;
  const found = await findBacklogItem(ctx, id);
  if (!found) return;
  const linked = linkedWorktrees(found.item, ctx.repository.current);
  let ws: Workstream | undefined = linked[0];
  if (linked.length > 1) {
    type Pick = vscode.QuickPickItem & { ws: Workstream };
    const now = new Date();
    const picked = await vscode.window.showQuickPick<Pick>(
      linked.map((w) => ({ label: `$(git-branch) ${workstreamLabel(w)}`, detail: describeWorkstream(w, now), ws: w })),
      { title: `Worktrees of ${id}`, placeHolder: newWindow ? 'Open which worktree in a new window?' : 'Show which worktree?' },
    );
    ws = picked?.ws;
  }
  if (!ws?.worktree.path) return;
  if (newWindow) await openWorktree(ctx, ws.worktree.path, true);
  else ctx.sidebar.reveal(ws.key);
}

/** Renames a local item in an input box (the card's menu); the title is the one thing it changes. */
async function renameBacklogItem(ctx: CommandContext, id: string | undefined): Promise<void> {
  if (!id) return;
  const item = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (!item) return;
  const title = await vscode.window.showInputBox({
    title: `Rename ${id}`,
    value: item.title,
    validateInput: (value) => (value.trim() ? undefined : 'A title is needed'),
  });
  if (!title?.trim() || title.trim() === item.title) return;
  await ctx.backlog.change((d) => updateItem(d, id, { title: title.trim() }));
}

/** Deletes a local item and its ticket, after a confirmation (the card's menu and the sidebar's trash button). */
async function deleteBacklogItem(ctx: CommandContext, id: string | undefined): Promise<void> {
  if (!id) return;
  const item = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (!item) return;
  const choice = await vscode.window.showWarningMessage(`Delete ${item.id} '${item.title}' from the backlog?`, { modal: true }, 'Delete');
  if (choice !== 'Delete') return;
  await ctx.backlog.change((d) => removeItem(d, id));
  await ctx.backlog.deleteDocument(id);
}

/**
 * Discards an item as "won't do" (BL-209), after a confirmation: its ticket is kept, and Reopen brings it back. Work
 * started on it ends (BL-210): its agents stop and its worktrees are removed, keeping their branches for a reopen.
 */
async function discardBacklogItem(ctx: CommandContext, id: string | undefined): Promise<void> {
  if (!id) return;
  const item = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (!item || item.discarded) return;
  const { agents, worktrees } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Checking what's started on ${item.id}…` },
    async () => {
      const linked = linkedWorktrees(item, ctx.repository.current).filter((w) => !removingWorktrees.has(w.key));
      const risks = await Promise.all(linked.map((w) => ctx.service.removalRisks(w.worktree).catch(() => ({ changedFiles: 0, unmergedCommits: 0 }))));
      return { agents: await ctx.tickets.agentsOn(id), worktrees: linked.map((ws, n) => ({ ws, changedFiles: risks[n].changedFiles })) };
    },
  );
  const choice = await vscode.window.showWarningMessage(
    `Discard ${item.id} '${item.title}' as won't do?`,
    { modal: true, detail: discardDetail({ agents, worktrees: worktrees.map((w) => ({ label: workstreamLabel(w.ws), changedFiles: w.changedFiles })) }) },
    'Discard',
  );
  if (choice !== 'Discard') return;
  // Discarded first, so nothing starts it again meanwhile; what fails after that is said in its entry.
  const branches = worktrees.flatMap((w) => (w.ws.worktree.branch ? [w.ws.worktree.branch] : []));
  await ctx.backlog.change((d) => branches.reduce((data, b) => addBranch(data, id, b), discardItem(d, id, new Date().toISOString())));
  // Even with no agent nor worktree yet, a start may wait in the queue: it's dropped too.
  const { stopped, left } = await ctx.tickets.stopForDiscard(id);
  // Its sisters are checked against it: what it was to do is now nobody's (BL-236).
  await ctx.backlog.noteScopeChange(id, 'discarded').catch(() => undefined);
  const removed: string[] = [];
  const current = worktrees.find((w) => w.ws.isCurrent);
  for (const { ws, changedFiles } of worktrees.filter((w) => w !== current)) {
    try {
      await executeRemoval(ctx, removalPlan(ctx, ws, changedFiles));
      removed.push(ws.worktree.branch ?? workstreamLabel(ws));
    } catch (error) {
      left.push(
        `The worktree of \`${ws.worktree.branch ?? workstreamLabel(ws)}\` couldn't be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const body = discardEntry({ stopped, removed, removing: current?.ws.worktree.branch, branches, left });
  const discarded = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (body && discarded) await ctx.backlog.appendActivity(discarded, { date: entryDate(new Date()), author: 'Flotilla', body });
  await noteDependents(ctx.backlog, id, entryDate(new Date()));
  // This window's worktree goes last, as Remove does it: main opens, and removes it.
  if (current) await removeCurrent(ctx, removalPlan(ctx, current.ws, current.changedFiles));
}

/** Removing a worktree, keeping its branch, quietly: the discard's entry says so (BL-210). */
function removalPlan(ctx: CommandContext, ws: Workstream, changedFiles: number): PendingRemoval {
  return {
    mainRoot: ctx.service.roots.mainRoot,
    adminDir: ws.worktree.adminDir,
    force: changedFiles > 0,
    deleteBranch: false,
    branch: ws.worktree.branch,
    createdAt: Date.now(),
    quiet: true,
  };
}

/**
 * Reopens a discarded item: back to To Do, or the status picked in its ticket's status bar (BL-231). Its ticket says
 * which branches of its earlier work are still there.
 */
async function reopenBacklogItem(ctx: CommandContext, id: string | undefined, status?: BacklogStatus): Promise<void> {
  if (!id) return;
  const before = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (!before?.discarded) return;
  await ctx.backlog.change((d) => reopenItem(d, id, status));
  const local = await ctx.service.listBranches().then(
    (b) => b.local,
    () => [] as string[],
  );
  const body = reopenEntry(local.filter((b) => branchMatches(before, b)));
  const item = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (body && item) await ctx.backlog.appendActivity(item, { date: entryDate(new Date()), author: 'Flotilla', body });
}

/** Readers of flotilla.backlog.commitPrefix. */
export function commitPrefixMode(): CommitPrefixMode {
  return vscode.workspace.getConfiguration('flotilla').get<CommitPrefixMode>('backlog.commitPrefix', 'agents');
}

let warnedTrackedHooks = false;

/**
 * Marks a worktree as working on an item, so that its commits start with the item's id (checked by the commit-msg
 * hook, installed here if needed). Hooks kept in the repository's files (Husky) aren't changed: the agent is then
 * only asked to.
 */
async function enforceCommitPrefix(ctx: CommandContext, ws: Workstream, id: string): Promise<void> {
  try {
    await markWorktree(ws.worktree.adminDir, id);
    const mode = commitPrefixMode();
    if ((await installCommitHook(ctx.service.roots.mainRoot, ctx.service.roots.commonDir, mode)) === 'tracked' && mode !== 'off' && !warnedTrackedHooks) {
      warnedTrackedHooks = true;
      void vscode.window.showWarningMessage(
        `This repository keeps its git hooks in its files (core.hooksPath), so Flotilla doesn't add its commit check there. Agents are still told to start commit messages with "${id}: ".`,
      );
    }
  } catch (error) {
    ctx.output.appendLine(`Couldn't set up the commit message check for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A local backlog item, or an issue from an integration (then with remote set). */
async function findBacklogItem(ctx: CommandContext, id: string): Promise<{ item: BacklogItem; remote?: RemoteIssue } | undefined> {
  const local = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (local) return { item: local };
  const remote = ctx.integrations.issues().find((i) => i.id === id);
  return remote && { item: { id: remote.id, title: remote.title, status: remote.status, created: '' }, remote };
}

/**
 * Creates a worktree for an item on a branch named by flotilla.backlog.branchPattern, from the default branch. A name
 * that's taken gets the next free number, without asking; askName shows that suggestion in an input box to change.
 * One creation per item at a time (creatingWorktrees): a start meanwhile creates nothing, the autopilot's (quiet) waits
 * for it and takes its worktree.
 */
async function newItemWorktree(ctx: CommandContext, item: BacklogItem, askName: boolean, quiet = false): Promise<Workstream | undefined> {
  if (creatingWorktrees.has(item.id)) return whileCreating(ctx, item, quiet);
  const pattern = vscode.workspace.getConfiguration('flotilla').get<string>('backlog.branchPattern', 'feature/{id}-{slug}');
  const branches = await ctx.service.listBranches();
  const checkedOut = new Set(ctx.repository.current.map((w) => w.worktree.branch));
  // A branch of the item that exists but has no worktree (removed earlier) is picked up again.
  let branch = itemBranches(item).find((b) => branches.local.includes(b) && !checkedOut.has(b)) ?? branchFor(item, pattern);
  if (askName || checkedOut.has(branch)) {
    let suggestion = branchFor(item, pattern);
    for (let n = 2; branches.local.includes(suggestion) || checkedOut.has(suggestion); n++) suggestion = `${branchFor(item, pattern)}-${n}`;
    const name = !askName
      ? suggestion
      : await vscode.window.showInputBox({
          title: `New worktree for ${item.id}`,
          prompt: 'Branch name (it should keep the item id, which links it to the item)',
          value: suggestion,
          validateInput: (v) => branchNameProblem(v.trim(), branches.local),
        });
    if (!name) return undefined;
    branch = name.trim();
  }
  const problem = branches.local.includes(branch) ? undefined : branchNameProblem(branch, []);
  if (problem) {
    if (quiet) throw new Error(`${problem} Change flotilla.backlog.branchPattern or the item's title.`);
    void vscode.window.showErrorMessage(`Can't start ${item.id}: ${problem} Change flotilla.backlog.branchPattern or the item's title.`);
    return undefined;
  }
  const base = (await resolveBase(ctx.service.roots.mainRoot, readSettings().defaultBase)) ?? 'HEAD';
  const request: CreateRequest = branches.local.includes(branch) ? { kind: 'existing', branch } : { kind: 'new', branch, startPoint: base };
  const made = await creatingWorktrees.run(item.id, () => createWorkstream(ctx, request, { quiet, label: item.id }));
  if (made.busy) return whileCreating(ctx, item, quiet);
  return ctx.repository.current.find((w) => w.key === made.value);
}

/** A start of an item while its worktree is being created: said (a user's), or waited for (the autopilot's). */
async function whileCreating(ctx: CommandContext, item: BacklogItem, quiet: boolean): Promise<Workstream | undefined> {
  if (!quiet) {
    void vscode.window.showInformationMessage(`${item.id}'s worktree is still being created.`);
    return undefined;
  }
  await creatingWorktrees.settled(item.id);
  return linkedWorktrees(item, ctx.repository.current)[0];
}

/**
 * A worktree for the autopilot's agent on an item, without asking anything: one of the item's that no chat is busy
 * in, else a new one. Its commits get the item's id; the item goes In Progress, on that branch.
 */
export async function prepareItemWorktree(ctx: CommandContext, item: BacklogItem): Promise<Workstream | undefined> {
  await creatingWorktrees.settled(item.id);
  const linked = ctx.repository.current.filter((w) => !w.worktree.isMain && w.worktree.path && w.worktree.branch && branchMatches(item, w.worktree.branch));
  const busy = (w: Workstream) => w.chats.some((c) => c.open && (c.state === 'working' || c.state === 'waiting-for-input'));
  const ws = linked.find((w) => !busy(w)) ?? (linked.length ? undefined : await newItemWorktree(ctx, item, false, true));
  if (!ws?.worktree.branch) return undefined;
  const branch = ws.worktree.branch;
  await enforceCommitPrefix(ctx, ws, item.id);
  await ctx.backlog.change((d) => updateItem(addBranch(d, item.id, branch), item.id, { status: 'doing' }), { by: 'Autopilot' });
  return ws;
}

/**
 * How agents keep their branch current with main (rebased and tidied, BL-181), and what they do when they need another
 * ticket's work (BL-55).
 */
export const mergeNotes = (id: string): string =>
  `Before you report "Ready for review.", rebase your branch onto main (the branch work merges into), resolve any conflicts commit by commit, tidy your commits into the steps a reviewer would want to read, and run the project's checks (build, tests) on the result, so the work lands cleanly as it is. ${tidyNotes(id)} Rebase only onto main, never onto another ticket's branch. If you need another ticket's work, don't take it from its branch: add a line "Depends on: <its id>" to the description and say so in your report; your ticket then shows that it waits for that one to be merged. Use "Depends on:" only when the work builds on another ticket's or reshapes the same feature, not because both change the same files: overlapping changes are reconciled when they merge.`;

/** Agents keep a todo list, so the ticket shows how far they are (BL-175). */
export const PLAN_NOTE =
  'Plan with your todo list (TodoWrite) when you start: a few steps, from reading to the final report. Keep it current as you go (mark a step in progress when you begin it, completed when it is done, and add steps you find): the ticket shows it to the user as your progress.';

/** What an agent is told when it starts on an item. */
export function agentPrompt(
  item: Pick<BacklogItem, 'id' | 'title' | 'links' | 'agent' | 'parent'>,
  ticket: string,
  branch: string,
  agent: string,
  guide: string,
  map?: CodeMap,
  items?: readonly BacklogItem[],
): string {
  const links = (item.links ?? []).map((l) => `${l.id} (${l.url})`);
  const level = levelNote(item);
  const epic = items && epicNote(item, items, path.dirname(guide));
  return [
    ...(links.length
      ? [
          `It's linked to ${links.length === 1 ? 'the issue' : 'the issues'} ${links.join(', ')}; mention ${links.length === 1 ? 'its key' : 'their keys'} in your commit messages.`,
        ]
      : []),
    `Its ticket is ${ticket}: Markdown with the title, the description, then an "## Activity" log of comments and reports. Read its title, description and the latest entries of its activity first (earlier entries only if you need them), with any images they link (paths relative to the ticket's folder). If its description has a "Where to start" section, begin there: it's what was found in the code when the ticket was shaped.`,
    ...(epic ? [epic] : []),
    CONTEXT_NOTES,
    ...(mapNote(map) ? [mapNote(map)!] : []),
    `Work in this git worktree, on branch ${branch}. Commit your work there with clear messages, each starting with "${item.id}: " (a git hook refuses others); don't push.`,
    `Report in the ticket: append entries at the end of its "## Activity" section (add the section if it's missing), each a heading "### YYYY-MM-DD HH:MM · Agent ${agent}" (local time; sign every entry as Agent ${agent}, which links it to this chat) followed by your report in Markdown. ${REPORT_FORMAT} Report your plan when you start, and when you finish what you did, how to try it and what's left. Don't change the title. Keep the description what's to be done: when the user asks for more or for something else, work it into the description (usually as acceptance criteria). ${KEEP_WHEN_DONE}`,
    PLAN_NOTE,
    `When the work is done, end your final report with a line "Ready for review." It's then reviewed (by another agent, or by the user); you may be asked to make changes.`,
    ...(level ? [level] : []),
    mergeNotes(item.id),
    reviewNotes({ id: item.id, backlogDir: path.dirname(guide) }),
    `If the work turns out to be several tickets' worth, or you find other work worth doing, add tickets to the backlog as ${guide} explains (parent: ${item.id} for parts of this one; agent: ${agent}). Mention them in your report.`,
    `Never change issue trackers yourself (Jira, GitHub Issues or others): no API calls, CLIs or tools that comment on, edit, move or create issues. The ticket is your only channel; the user decides what gets posted to the tracker.`,
  ].join('\n\n');
}

/** A short name for a new agent, not used by another agent's chat: its chat's first line and its reports carry it. */
function newAgentName(ctx: CommandContext): string {
  return agentName(ctx.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean));
}

/**
 * Starts an agent to fix a failed CI job, in the worktree on the run's branch. When the branch carries a backlog item's
 * id, the agent works through that item's ticket, and the ticket's activity notes the failure; otherwise the task alone.
 */
async function fixWithAgent(ctx: CommandContext, failure: unknown): Promise<void> {
  const job = parseFailedJob(failure);
  if (!job) {
    void vscode.window.showWarningMessage('Fix with Agent needs a failed CI job.');
    return;
  }
  const ws = ctx.repository.current.find((w) => w.worktree.path && w.worktree.branch === job.branch);
  const refusal = fixRefusal(job, ws?.worktree);
  if (!ws?.worktree.path || refusal) {
    void vscode.window.showWarningMessage(refusal ?? `No worktree has branch ${job.branch}.`);
    return;
  }
  const task = failureTask(job);
  const item = (await ctx.backlog.read()).items.find((i) => branchMatches(i, job.branch));
  if (!item) {
    const choice = agentChoice(undefined);
    await chatUi.startAgent(chatContext(ctx), ws, task, '', { choice, name: `Fix CI · ${job.branch}` });
    return;
  }
  await enforceCommitPrefix(ctx, ws, item.id);
  const agent = newAgentName(ctx);
  const ticket = await ctx.backlog.ensureDocument(item);
  const choice = agentChoice(item);
  const map = await mapFor(ctx.backlog, ctx.service.roots.mainRoot, item);
  const prompt = [task, agentPrompt(item, ticket, workstreamLabel(ws), agent, path.join(ctx.backlog.dir, GUIDE), map, (await ctx.backlog.read()).items)].join(
    '\n\n',
  );
  const where = await chatUi.startAgent(chatContext(ctx), ws, prompt, agentLead(item, agent), {
    choice,
    name: `${agent} · ${item.id}`,
    track: { ticket: item.id, agent, role: 'work' },
  });
  const steps = job.failedSteps.length ? ` (failed steps: ${job.failedSteps.join(', ')})` : '';
  await ctx.tickets.addActivity(
    item.id,
    'Flotilla',
    `The CI run [${job.run.name}](${job.run.url}) failed: job ${job.job.name}${steps}, on commit ${job.run.commit}. Opened a chat for agent ${agent}${describeChoice(choice)} in worktree \`${workstreamLabel(ws)}\`${where === 'terminal' ? ', in a terminal' : ''}, to fix it. It reports here.`,
  );
}

/**
 * Starts an agent on an item, working in its worktree: a local item's agent runs without a window, through the agent
 * queue, as the autopilot's do (BL-122); an issue from a tracker gets a Claude Code chat.
 */
async function runAgent(ctx: CommandContext, item: BacklogItem, ws: Workstream, remote?: RemoteIssue): Promise<void> {
  if (!remote && ctx.startWork) {
    // As it is now: starting it moved it to In Progress, and the queue gives up starts on an item that changed.
    const fresh = (await ctx.backlog.read()).items.find((i) => i.id === item.id);
    if (fresh) await ctx.startWork(fresh, ws);
    return;
  }
  let ticket: string;
  if (remote) {
    // The issue lives in its tracker; the agent gets a local copy of it to read and to report in.
    const source = await ctx.integrations.sourceOf(item.id);
    const details = source && (await source.details(item.id));
    const description = [details?.descriptionText.trim(), `(The issue in ${source?.label ?? 'its tracker'}: ${remote.url})`].filter(Boolean).join('\n\n');
    await ctx.backlog.editTicket(item, (local) => ({ title: item.title, description, activity: local.activity }));
    ticket = ctx.backlog.docPath(item.id);
  } else {
    ticket = await ctx.backlog.ensureDocument(item);
  }
  // In Claude Code's chat, linked to the worktree. Claude Code fills in the message; sending it starts the agent.
  // The chat's first line names the item: that's how its ticket finds the chat (agentChatItem).
  const agent = newAgentName(ctx);
  const choice = agentChoice(item);
  const map = remote ? undefined : await mapFor(ctx.backlog, ctx.service.roots.mainRoot, item);
  const items = remote ? undefined : (await ctx.backlog.read()).items;
  const where = await chatUi.startAgent(
    chatContext(ctx),
    ws,
    agentPrompt(item, ticket, workstreamLabel(ws), agent, path.join(ctx.backlog.dir, GUIDE), map, items),
    agentLead(item, agent),
    {
      choice,
      name: `${agent} · ${item.id}`,
      track: { ticket: item.id, agent, role: 'work' },
    },
  );
  await ctx.tickets.addActivity(
    item.id,
    'Flotilla',
    `Opened a chat for agent ${agent}${describeChoice(choice)} in worktree \`${workstreamLabel(ws)}\`${where === 'terminal' ? ', in a terminal' : ''}. It reports here.`,
  );
}

/**
 * Opens a Claude Code chat that plans the backlog with the user: it reads the backlog, breaks work down, and adds
 * tickets through the inbox. One way among others: any agent can add tickets.
 */
async function planBacklog(ctx: CommandContext): Promise<void> {
  await ctx.backlog.ensureDir();
  const guide = path.join(ctx.backlog.dir, GUIDE);
  await chatUi.askClaude(
    [
      `Help me plan this repository's backlog. First read ${guide}: it explains the backlog (backlog.json, a ticket file per item) and how to add tickets (the inbox).`,
      `Look at the backlog and, where it helps, at the code. Then ask me what I want to get done. Break big work down into tickets (parts of an item get parent: <its id>), add new tickets through the inbox, and improve the tickets I point you to by editing their descriptions in their .md files.`,
      `Don't implement anything yourself: work is started from the tickets, by me or by agents.`,
      '',
    ].join('\n\n'),
  );
}

/** Links a local item to an issue in a connected tracker (Jira, GitHub Issues). */
async function linkBacklogItem(ctx: CommandContext, id: unknown): Promise<void> {
  if (typeof id !== 'string') return;
  const data = await ctx.backlog.read();
  if (!data.items.some((i) => i.id === id)) return;
  // An issue is linked to one item at most (it then shows as part of that item).
  const linked = data.items.flatMap((i) => (i.links ?? []).map((l) => l.id));
  const link = await ctx.integrations.pickIssue(id, linked);
  if (!link) return;
  await ctx.backlog.change((d) => linkIssue(d, id, link));
  await ctx.tickets.addActivity(id, 'Flotilla', `Linked to [${link.id}](${link.url}): ${link.title}`);
}

async function runSetupNow(ctx: CommandContext, dir: string): Promise<void> {
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  ctx.output.appendLine(copied.length ? `Copied into ${dir}: ${copied.join(', ')}` : `No setup files to copy into ${dir}.`);
  await linkSetupFolders(ctx, dir, settings.linkFolders, false);
  if (!settings.setupCommand.trim()) {
    if (!copied.length) void vscode.window.showInformationMessage('Nothing to do: set flotilla.copyFiles or flotilla.setupCommand.');
    return;
  }
  startSetupTerminal(dir, settings.setupCommand);
}

/** Gives a worktree the main worktree's `flotilla.linkFolders` as hard links, and says in the output what it did. */
async function linkSetupFolders(ctx: CommandContext, dir: string, folders: readonly string[], quiet: boolean | undefined): Promise<void> {
  if (!folders.length) return;
  const results = await vscode.window.withProgress(
    { location: quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: `Linking ${folders.join(', ')}…` },
    () => linkFolders(ctx.service.roots.mainRoot, dir, folders),
  );
  for (const r of results) {
    const copied = r.copied ? `, and copied ${r.copied} that installs or tools write in place` : '';
    ctx.output.appendLine(r.skipped ? `Didn't link ${r.folder} into ${dir}: ${r.skipped}.` : `Linked ${r.folder} into ${dir}: ${r.files} files${copied}.`);
  }
}

function startSetupTerminal(dir: string, command: string): void {
  if (!command.trim()) return;
  const terminal = vscode.window.createTerminal({ name: `Setup: ${path.basename(dir)}`, cwd: dir });
  terminal.show(true);
  terminal.sendText(command);
}

async function quickSwitch(ctx: CommandContext): Promise<void> {
  type Item = vscode.QuickPickItem & { ws?: Workstream };
  const now = new Date();
  const newWindowButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: 'Open in New Window' };
  const items: Item[] = ctx.repository.current
    .filter((ws) => ws.worktree.path)
    .map((ws) => ({
      label: `${ws.isCurrent ? '$(check) ' : ''}${workstreamLabel(ws)}`,
      description: describeWorkstream(ws, now),
      ws,
      buttons: ws.isCurrent ? [] : [newWindowButton],
    }));
  items.push({ label: '$(add) New workstream…' });
  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.items = items;
  quickPick.placeholder = 'Switch this window to a workstream (or use the button to open a new window)';
  const result = await new Promise<{ item?: Item; newWindow: boolean }>((resolve) => {
    quickPick.onDidAccept(() => resolve({ item: quickPick.selectedItems[0], newWindow: false }));
    quickPick.onDidTriggerItemButton((e) => resolve({ item: e.item, newWindow: true }));
    quickPick.onDidHide(() => resolve({ newWindow: false }));
    quickPick.show();
  });
  quickPick.dispose();
  if (!result.item) return;
  if (!result.item.ws) return newWorkstream(ctx);
  if (result.item.ws.isCurrent) return;
  await openWorktree(ctx, result.item.ws.worktree.path!, result.newWindow);
}

async function compareWith(ctx: CommandContext, ws: Workstream): Promise<void> {
  const dir = ws.worktree.path!;
  const branches = await ctx.service.listBranches();
  const defaultBase = await resolveBase(dir, readSettings().defaultBase);
  const options = [...new Set([defaultBase, ...branches.local, ...branches.remote])].filter((b): b is string => b !== undefined && b !== ws.worktree.branch);
  const base = await vscode.window.showQuickPick(options, { title: `Compare '${workstreamLabel(ws)}' with…` });
  if (!base) return;
  const modes: Array<vscode.QuickPickItem & { mode: CompareMode }> = [
    { label: 'Since the branches diverged', description: 'merge-base', mode: 'mergeBase' },
    { label: 'Including uncommitted changes', mode: 'uncommitted' },
    { label: 'Two-dot', description: `${base}..HEAD`, mode: 'twoDot' },
  ];
  const mode = await vscode.window.showQuickPick(modes, { title: `Compare '${workstreamLabel(ws)}' with ${base}` });
  if (!mode) return;
  const result = await compareWithBase(dir, base, mode.mode);
  if (!result.files.length) {
    void vscode.window.showInformationMessage(`No differences between '${workstreamLabel(ws)}' and ${base}.`);
    return;
  }
  await openChangesEditor(ctx.reference, dir, result.files, result.leftRef, result.rightRef, `${base} ↔ ${workstreamLabel(ws)}`);
}

const GROUP_REFS: Record<ChangeGroup, [string, string, string]> = {
  staged: ['HEAD', INDEX, 'Staged Changes'],
  unstaged: [INDEX, WORKING, 'Changes'],
};

async function openFileDiff(ctx: CommandContext, ws: Workstream, relPath: string, group: ChangeGroup): Promise<void> {
  const change = ws[group].find((c) => c.path === relPath);
  if (!change) return openFile(ctx, ws, relPath);
  // Conflicted files have no single staged version; show them against HEAD.
  const [left, right] = change.kind === 'conflicted' ? ['HEAD', WORKING] : GROUP_REFS[group];
  await openChangeDiff(ctx.reference, ws.worktree.path!, change, left, right, `${workstreamLabel(ws)}: ${group === 'staged' ? 'staged' : 'working tree'}`);
}

async function openGroupChanges(ctx: CommandContext, ws: Workstream, group: ChangeGroup): Promise<void> {
  const [left, right, title] = GROUP_REFS[group];
  if (!ws[group].length) return;
  await openChangesEditor(ctx.reference, ws.worktree.path!, ws[group], left, right, `${workstreamLabel(ws)}: ${title}`);
}

async function openFile(ctx: CommandContext, ws: Workstream, relPath: string | undefined): Promise<void> {
  if (!relPath || !ws.worktree.path) return;
  if (ws.unstaged.some((c) => c.path === relPath && c.kind === 'deleted')) {
    void vscode.window.showInformationMessage(`${relPath} was deleted.`);
    return;
  }
  await vscode.window.showTextDocument(toWorkspaceUri(ctx.reference, resolveInside(ws.worktree.path, relPath)), { preview: false });
}

/** Open Changes of a file row's right-click menu in History, Compare or a ticket's views (BL-244): the diff its click opens. */
async function openVcFileChanges(ctx: CommandContext, arg: unknown): Promise<void> {
  const diff = vcFileDiffOf(arg);
  if (diff) await ctx.sidebar.openDiff(diff);
}

/** Reveals a file or a worktree folder in the Explorer; it must be inside a workspace folder. */
async function revealInExplorer(ctx: CommandContext, arg: Arg): Promise<void> {
  const ws = await pickWorkstream(ctx, arg, {});
  if (!ws?.worktree.path) return;
  const target = isTarget(arg) && arg.path ? resolveInside(ws.worktree.path, arg.path) : ws.worktree.path;
  const visible = (vscode.workspace.workspaceFolders ?? []).some((f) => samePath(f.uri.fsPath, target) || isInside(f.uri.fsPath, target));
  if (!visible) {
    const choice = await vscode.window.showInformationMessage(
      `'${workstreamLabel(ws)}' is outside this window's folder, so the Explorer can't show it.`,
      'Add to Workspace',
    );
    if (!choice) return;
    addWorkspaceFolder(ctx.reference, ws.worktree.path, `⎇ ${workstreamLabel(ws)}`);
    return;
  }
  await vscode.commands.executeCommand('revealInExplorer', toWorkspaceUri(ctx.reference, target));
}

export async function removeWorkstream(ctx: CommandContext, ws: Workstream): Promise<void> {
  const wt = ws.worktree;
  if (wt.isMain) {
    void vscode.window.showWarningMessage('The main worktree cannot be removed.');
    return;
  }
  if (!wt.path) return forgetWorkstream(ctx, ws);
  if (removingWorktrees.has(ws.key)) return;
  const risks = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Checking '${workstreamLabel(ws)}' before removing it…` },
    () => ctx.service.removalRisks(wt),
  );
  const lines: string[] = [];
  if (risks.changedFiles) lines.push(`${risks.changedFiles} uncommitted or untracked file(s) will be deleted.`);
  if (risks.unmergedCommits && wt.branch) {
    lines.push(`Branch '${wt.branch}' has ${risks.unmergedCommits} commit(s) that are on no other branch or remote.`);
  }
  lines.push('If this worktree is open in another window (including another environment), that window will lose its folder.');
  const removeOnly = 'Remove';
  const removeAndDelete = 'Remove and Delete Branch';
  const choice = await vscode.window.showWarningMessage(
    `Remove worktree '${workstreamLabel(ws)}'?`,
    { modal: true, detail: lines.join('\n') },
    ...(wt.branch ? [removeOnly, removeAndDelete] : [removeOnly]),
  );
  if (!choice) return;
  const plan: PendingRemoval = {
    mainRoot: ctx.service.roots.mainRoot,
    adminDir: wt.adminDir,
    force: risks.changedFiles > 0,
    deleteBranch: choice === removeAndDelete,
    branch: wt.branch,
    createdAt: Date.now(),
  };
  if (ws.isCurrent) return removeCurrent(ctx, plan);
  await executeRemoval(ctx, plan);
}

/** Removes this window's worktree: main opens in this window, and removes it from there (see the pending removal). */
async function removeCurrent(ctx: CommandContext, plan: PendingRemoval): Promise<void> {
  await ctx.extension.globalState.update(PENDING_REMOVAL_KEY, plan);
  try {
    await openWorktree(ctx, plan.mainRoot, false);
  } catch (error) {
    await ctx.extension.globalState.update(PENDING_REMOVAL_KEY, undefined);
    throw error;
  }
}

async function executeRemoval(ctx: CommandContext, plan: PendingRemoval): Promise<void> {
  const wt = (await ctx.service.list()).find((w) => samePath(w.adminDir, plan.adminDir));
  if (!wt) {
    void vscode.window.showInformationMessage(
      `The worktree${plan.branch ? ` for '${plan.branch}'` : ''} no longer exists, so nothing was removed${plan.deleteBranch && plan.branch ? ' and the branch was kept' : ''}.`,
    );
    await ctx.repository.refresh();
    return;
  }
  // Its row shows it's being removed until it's gone (or the removal failed and it's back as it was).
  await removingWorktrees.run(wt.adminDir, () => removeAndRecord(ctx, plan, wt));
}

async function removeAndRecord(ctx: CommandContext, plan: PendingRemoval, wt: ResolvedWorktree): Promise<void> {
  if (extraWorkspaceFolder(wt.path)) removeWorkspaceFolder(wt.path);
  await ctx.service.remove(wt, { force: plan.force });
  let deleted = false;
  if (plan.deleteBranch && plan.branch) {
    try {
      await ctx.service.deleteBranch(plan.branch, false);
    } catch (error) {
      const choice = await vscode.window.showWarningMessage(
        `Branch '${plan.branch}' is not fully merged. Delete it anyway?`,
        { modal: true, detail: error instanceof Error ? error.message : String(error) },
        'Delete Anyway',
      );
      if (choice) await ctx.service.deleteBranch(plan.branch, true);
      deleted = !!choice;
    }
    deleted ||= !(await ctx.service.listBranches()).local.includes(plan.branch);
  }
  // The tickets the worktree worked on say so (a discard's says it itself).
  if (plan.branch && !plan.quiet) {
    const branch = plan.branch;
    for (const item of (await ctx.backlog.read()).items.filter((i) => branchMatches(i, branch))) {
      await ctx.backlog.appendActivity(item, {
        date: entryDate(new Date()),
        author: 'Flotilla',
        body: `You removed the worktree of \`${branch}\`${deleted ? ', and deleted the branch' : '; the branch stays'}.`,
      });
    }
  }
  await ctx.repository.refresh();
}

async function forgetWorkstream(ctx: CommandContext, ws: Workstream): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Forget worktree '${workstreamLabel(ws)}'?`,
    {
      modal: true,
      detail:
        `It is not reachable from this environment (git recorded it at ${ws.worktree.recordedPath}). ` +
        'If it still exists in another environment, remove it from there instead. ' +
        "Forgetting deletes git's record of it; no worktree files are touched.",
    },
    'Forget',
  );
  if (!choice) return;
  await ctx.service.forget(ws.worktree);
  await ctx.repository.refresh();
}
