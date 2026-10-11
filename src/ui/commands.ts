import * as path from 'node:path';
import * as vscode from 'vscode';
import { openChangeDiff, openChangesEditor } from '../core/diff/openDiff';
import { INDEX, WORKING } from '../core/diff/refs';
import { GitError } from '../core/git/gitCli';
import { isInside, resolveInside, samePath } from '../core/paths';
import type { Repository } from '../core/repository';
import { toWorkspaceUri } from '../core/uris';
import { addBranch, agentChatItem, agentLead, agentName, branchFor, branchMatches, itemBranches, linkIssue, updateItem, type BacklogItem } from '../features/backlog/backlog';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import type { RemoteIssue } from '../features/backlog/sources/source';
import type { BacklogIntegrations } from './backlog/integrations';
import type { TicketPanels } from './backlog/ticketPanel';
import { compareWithBase, type CompareMode } from '../features/diffs/compare';
import * as scm from '../features/scm/operations';
import { clearAgentStatus } from '../features/workstreams/agentStatus';
import { resolveBase } from '../features/workstreams/progress';
import { installCommitHook, markWorktree, type CommitPrefixMode } from '../features/backlog/commitHook';
import { GUIDE } from '../features/backlog/inbox';
import { envFromRemoteName } from '../features/workstreams/heartbeat';
import type { Workstream } from '../features/workstreams/workstream';
import { branchNameProblem } from '../features/worktrees/layout';
import { copySetupFiles } from '../features/worktrees/setup';
import type { BranchList, CreateRequest, WorktreeService } from '../features/worktrees/worktreeService';
import type { ChangeGroup, Target } from '../webview/protocol';
import { branchPickEntries, type BranchPickAction } from './branchPicker';
import * as chatUi from './chatCommands';
import { claudeHookConfig } from './claudeHooks';
import { describeWorkstream, workstreamLabel } from './format';
import { maybeOfferHygiene } from './hygiene';
import { removalToRun, type PendingRemoval } from './pending';
import * as scmUi from './scmCommands';
import { readSettings } from './settings';
import { addWorkspaceFolder, extraWorkspaceFolder, removeWorkspaceFolder } from './workspaceFolders';

/** What the sidebar offers to commands. */
export interface SidebarHandle {
  reveal(key: string): void;
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
}

const PENDING_REMOVAL_KEY = 'flotilla.pendingRemoval';

interface PickFilter {
  includeUnreachable?: boolean;
  excludeMain?: boolean;
}

type Handler = (...args: any[]) => unknown;
/** Commands get a Target from the sidebar (or its context menus), a folder Uri from the Explorer, or nothing from the palette. */
type Arg = Target | vscode.Uri | undefined;

export function isTarget(arg: unknown): arg is Target {
  return typeof arg === 'object' && arg !== null && !(arg instanceof vscode.Uri) && typeof (arg as Target).key === 'string';
}

/** The files a file command acts on: a multi-selection, or the one clicked file. */
function targetPaths(arg: unknown): string[] {
  if (!isTarget(arg)) return [];
  return arg.paths?.length ? arg.paths : arg.path ? [arg.path] : [];
}

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
  const register = (id: string, handler: Handler) => ctx.extension.subscriptions.push(vscode.commands.registerCommand(id, guard(ctx, handler)));
  const withWs =
    (handler: (ws: Workstream, arg: Arg) => unknown, filter: PickFilter = {}) =>
    async (arg?: Arg) => {
      const ws = await pickWorkstream(ctx, arg, filter);
      if (ws) await handler(ws, arg);
    };
  const scmCtx = scmUi.scmContext(ctx.repository);
  const chats = chatContext(ctx);

  register('flotilla.refresh', () => ctx.repository.refresh());
  register('flotilla.newWorkstream', () => newWorkstream(ctx));
  register('flotilla.startBacklogItem', (id?: unknown, opts?: unknown) => startBacklogItem(ctx, id, opts));
  register('flotilla.writeBacklogItem', (id?: unknown) => writeBacklogItem(ctx, id));
  register('flotilla.backlogIntegrations', () => ctx.integrations.manage());
  register('flotilla.planBacklog', () => planBacklog(ctx));
  register('flotilla.linkBacklogItem', (id?: unknown) => linkBacklogItem(ctx, id));
  register('flotilla.openBacklogItem', (id?: unknown) => typeof id === 'string' && ctx.tickets.open(id));
  register('flotilla.quickSwitch', () => quickSwitch(ctx));
  register('flotilla.openInNewWindow', withWs((ws) => openWorktree(ctx, ws.worktree.path!, true)));
  register('flotilla.switchHere', withWs((ws) => openWorktree(ctx, ws.worktree.path!, false)));
  register('flotilla.remove', withWs((ws) => removeWorkstream(ctx, ws), { includeUnreachable: true, excludeMain: true }));
  register(
    'flotilla.adopt',
    withWs(
      async (ws) => {
        await ctx.service.adopt(ws.worktree);
        void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
        await ctx.repository.refresh();
      },
      { excludeMain: true },
    ),
  );
  register('flotilla.runSetupHere', withWs((ws) => runSetupNow(ctx, ws.worktree.path!), { excludeMain: true }));
  register('flotilla.openTerminal', withWs((ws) => vscode.window.createTerminal({ name: workstreamLabel(ws), cwd: ws.worktree.path }).show()));
  register('flotilla.copyPath', withWs((ws, arg) => vscode.env.clipboard.writeText(resolveInside(ws.worktree.path!, (isTarget(arg) && arg.path) || ''))));
  register('flotilla.revealInOS', withWs((ws) => vscode.commands.executeCommand('revealFileInOS', toWorkspaceUri(ctx.reference, ws.worktree.path!))));
  register('flotilla.compareWith', withWs((ws) => compareWith(ctx, ws)));
  register('flotilla.openFile', withWs((ws, arg) => openFile(ctx, ws, isTarget(arg) ? arg.path : undefined)));
  register('flotilla.openFileDiff', withWs((ws, arg) => isTarget(arg) && arg.path && openFileDiff(ctx, ws, arg.path, arg.group ?? 'unstaged')));
  register('flotilla.openChanges', withWs((ws, arg) => openGroupChanges(ctx, ws, (isTarget(arg) && arg.group) || 'unstaged')));
  register('flotilla.stage', withWs((ws, arg) => scmUi.stagePaths(scmCtx, ws, targetPaths(arg))));
  register('flotilla.unstage', withWs((ws, arg) => scmUi.unstagePaths(scmCtx, ws, targetPaths(arg))));
  register(
    'flotilla.discard',
    withWs((ws, arg) => {
      const paths = new Set(targetPaths(arg));
      if (paths.size) return scmUi.discardChanges(scmCtx, ws, ws.unstaged.filter((c) => paths.has(c.path)));
    }),
  );
  register('flotilla.stageAll', withWs((ws) => scmUi.stageAll(scmCtx, ws)));
  register('flotilla.unstageAll', withWs((ws) => scmUi.unstageAll(scmCtx, ws)));
  register('flotilla.discardAll', withWs((ws) => scmUi.discardChanges(scmCtx, ws)));
  register('flotilla.commit', withWs((ws) => scmUi.commit(scmCtx, ws)));
  register('flotilla.publish', withWs((ws) => scmUi.publish(scmCtx, ws)));
  register('flotilla.sync', withWs((ws) => scmUi.sync(scmCtx, ws)));
  register('flotilla.push', withWs((ws) => scmUi.network(scmCtx, ws, 'Pushing', scm.push)));
  register('flotilla.pull', withWs((ws) => scmUi.network(scmCtx, ws, 'Pulling', scm.pull)));
  register('flotilla.fetch', withWs((ws) => scmUi.network(scmCtx, ws, 'Fetching', scm.fetch)));
  register(
    'flotilla.addToWorkspace',
    withWs(
      (ws) => {
        if (ws.isCurrent) return vscode.window.showInformationMessage(`'${workstreamLabel(ws)}' is already this window's folder.`);
        addWorkspaceFolder(ctx.reference, ws.worktree.path!, `⎇ ${workstreamLabel(ws)}`);
      },
      { excludeMain: true },
    ),
  );
  register('flotilla.removeFromWorkspace', withWs((ws) => removeWorkspaceFolder(ws.worktree.path)));
  register('flotilla.revealInExplorer', (arg?: Arg) => revealInExplorer(ctx, arg));
  // Chats
  register('flotilla.newChat', withWs((ws) => chatUi.newChat(chats, ws)));
  register('flotilla.openChat', withWs((ws, arg) => isTarget(arg) && arg.chatId && chatUi.openChat(chats, ws, arg.chatId)));
  register('flotilla.unlinkChat', withWs((ws, arg) => isTarget(arg) && arg.chatId && chatUi.unlink(chats, ws, arg.chatId)));
  register('flotilla.linkChat', withWs((ws) => chatUi.link(chats, ws)));
  register('flotilla.installClaudeHooks', (arg?: Arg) => chatUi.installChatHooks(chats, isTarget(arg) ? ctx.repository.current.find((w) => w.key === arg.key) : undefined));
  register(
    'flotilla.clearAgentStatus',
    withWs(
      async (ws) => {
        await clearAgentStatus(ws.worktree.adminDir);
        await ctx.repository.refresh();
      },
      { includeUnreachable: true },
    ),
  );
  register('flotilla.copyClaudeHookConfig', async () => {
    await vscode.env.clipboard.writeText(claudeHookConfig());
    void vscode.window.showInformationMessage(
      'Claude Code hook config copied. The hooks also need the hook script, .claude/flotilla-hook.js, in each worktree: run Flotilla: Install Claude Code Hooks to set up both.',
    );
  });
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
  const candidates = ctx.repository.current.filter(
    (ws) => (filter.includeUnreachable || ws.worktree.path) && !(filter.excludeMain && ws.worktree.isMain),
  );
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
async function pickBranchAction(branches: BranchList, checkedOut: ReadonlyMap<string, string>): Promise<{ action: BranchPickAction; typed: string } | undefined> {
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
    if (ws.worktree.branch) checkedOut.set(ws.worktree.branch, ws.worktree.isMain ? 'the main worktree' : path.basename(ws.worktree.path ?? ws.worktree.recordedPath));
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
async function createWorkstream(ctx: CommandContext, request: CreateRequest): Promise<string> {
  const created = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating worktree…' },
    () => ctx.service.create(request),
  );
  const dir = created.path!;
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  if (copied.length) ctx.output.appendLine(`Copied into ${dir}: ${copied.join(', ')}`);
  startSetupTerminal(dir, settings.setupCommand);
  await ctx.repository.refresh();
  ctx.sidebar.reveal(created.adminDir);
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
 * agent then works on it in that worktree, reporting in the item's ticket.
 */
async function startBacklogItem(ctx: CommandContext, id: unknown, opts?: unknown): Promise<void> {
  if (typeof id !== 'string') return;
  const agent = typeof opts === 'object' && opts !== null && (opts as { agent?: unknown }).agent === true;
  const found = await findBacklogItem(ctx, id);
  if (!found) return;
  const { item, remote } = found;
  // A branch of the item that has no worktree (anymore): a worktree for it.
  const branchOpt = typeof opts === 'object' && opts !== null ? (opts as { branch?: unknown }).branch : undefined;
  if (typeof branchOpt === 'string' && branchMatches(item, branchOpt)) {
    const key = await createWorkstream(ctx, { kind: 'existing', branch: branchOpt });
    const created = ctx.repository.current.find((w) => w.key === key);
    if (created) await enforceCommitPrefix(ctx, created, item.id);
    if (key) ctx.sidebar.reveal(key);
    return;
  }
  const linked = ctx.repository.current.filter((w) => !w.worktree.isMain && w.worktree.path && w.worktree.branch && branchMatches(item, w.worktree.branch));
  let ws: Workstream | undefined;
  if (!linked.length) {
    ws = await newItemWorktree(ctx, item, false);
  } else {
    // An epic has several worktrees: start in one of them, or in a new one.
    type Pick = vscode.QuickPickItem & { ws?: Workstream };
    const now = new Date();
    const picks: Pick[] = [
      ...linked.map((w) => ({ label: `$(git-branch) ${workstreamLabel(w)}`, detail: describeWorkstream(w, now), ws: w })),
      { label: `$(add) New Worktree for ${item.id}…`, detail: 'Another branch for this item, e.g. one part of an epic' },
    ];
    const picked = await vscode.window.showQuickPick(picks, {
      title: agent ? `Start an agent on ${item.id}` : `Work on ${item.id}`,
      placeHolder: 'In which worktree?',
    });
    if (!picked) return;
    ws = picked.ws ?? (await newItemWorktree(ctx, item, true));
  }
  if (!ws?.worktree.branch) return;
  const branch = ws.worktree.branch;
  await enforceCommitPrefix(ctx, ws, item.id);
  // Issues from integrations aren't in the local backlog: their branch carries their key, which links them.
  if (!remote) await ctx.backlog.change((d) => updateItem(addBranch(d, id, branch), id, { status: item.status === 'done' ? 'done' : 'doing' }));
  ctx.sidebar.reveal(ws.key);
  if (agent && ws.worktree.path) await runAgent(ctx, item, ws, remote);
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
 * Creates a worktree for an item on a branch named by flotilla.backlog.branchPattern, from the default branch. For
 * another worktree of the same item (askName), the name is suggested with a number and can be changed.
 */
async function newItemWorktree(ctx: CommandContext, item: BacklogItem, askName: boolean): Promise<Workstream | undefined> {
  const pattern = vscode.workspace.getConfiguration('flotilla').get<string>('backlog.branchPattern', 'feature/{id}-{slug}');
  const branches = await ctx.service.listBranches();
  const checkedOut = new Set(ctx.repository.current.map((w) => w.worktree.branch));
  // A branch of the item that exists but has no worktree (removed earlier) is picked up again.
  let branch = itemBranches(item).find((b) => branches.local.includes(b) && !checkedOut.has(b)) ?? branchFor(item, pattern);
  if (askName || checkedOut.has(branch)) {
    let suggestion = branchFor(item, pattern);
    for (let n = 2; branches.local.includes(suggestion) || checkedOut.has(suggestion); n++) suggestion = `${branchFor(item, pattern)}-${n}`;
    const name = await vscode.window.showInputBox({
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
    void vscode.window.showErrorMessage(`Can't start ${item.id}: ${problem} Change flotilla.backlog.branchPattern or the item's title.`);
    return undefined;
  }
  const base = (await resolveBase(ctx.service.roots.mainRoot, readSettings().defaultBase)) ?? 'HEAD';
  const request: CreateRequest = branches.local.includes(branch) ? { kind: 'existing', branch } : { kind: 'new', branch, startPoint: base };
  const key = await createWorkstream(ctx, request);
  return ctx.repository.current.find((w) => w.key === key);
}

/** What an agent is told when it starts on an item. */
export function agentPrompt(item: Pick<BacklogItem, 'id' | 'title' | 'links'>, ticket: string, branch: string, agent: string, guide: string): string {
  const links = (item.links ?? []).map((l) => `${l.id} (${l.url})`);
  return [
    ...(links.length ? [`It's linked to ${links.length === 1 ? 'the issue' : 'the issues'} ${links.join(', ')}; mention ${links.length === 1 ? 'its key' : 'their keys'} in your commit messages.`] : []),
    `Its ticket is ${ticket}: Markdown with the title, the description, then an "## Activity" log of comments and reports. Read it first, with any images it links (paths relative to the ticket's folder).`,
    `Work in this git worktree, on branch ${branch}. Commit your work there with clear messages, each starting with "${item.id}: " (a git hook refuses others); don't push.`,
    `Report in the ticket: append entries at the end of its "## Activity" section (add the section if it's missing), each a heading "### YYYY-MM-DD HH:MM · Agent ${agent}" (local time; sign every entry as Agent ${agent}, which links it to this chat) followed by your report in Markdown. Report your plan when you start, ask there when you need a decision (and wait), and when you finish say what you did, how to try it and what's left. Don't change the title or description.`,
    `When the work is done, end your final report with a line "Ready for review." Another agent then reviews it; you may be asked to make changes.`,
    `If the work turns out to be several tickets' worth, or you find other work worth doing, add tickets to the backlog as ${guide} explains (parent: ${item.id} for parts of this one; agent: ${agent}). Mention them in your report.`,
    `Never change issue trackers yourself (Jira, GitHub Issues or others): no API calls, CLIs or tools that comment on, edit, move or create issues. The ticket is your only channel; the user decides what gets posted to the tracker.`,
  ].join('\n\n');
}

/** Opens a Claude Code chat for an agent on an item, working in its worktree. */
async function runAgent(ctx: CommandContext, item: BacklogItem, ws: Workstream, remote?: RemoteIssue): Promise<void> {
  let ticket: string;
  if (remote) {
    // The issue lives in its tracker; the agent gets a local copy of it to read and to report in.
    const source = await ctx.integrations.sourceOf(item.id);
    const details = source && (await source.details(item.id));
    const local = await ctx.backlog.readTicket(item);
    const description = [details?.descriptionText.trim(), `(The issue in ${source?.label ?? 'its tracker'}: ${remote.url})`].filter(Boolean).join('\n\n');
    await ctx.backlog.writeTicket(item.id, { title: item.title, description, activity: local.activity });
    ticket = ctx.backlog.docPath(item.id);
  } else {
    ticket = await ctx.backlog.ensureDocument(item);
  }
  // In Claude Code's chat, linked to the worktree. Claude Code fills in the message; sending it starts the agent.
  // The chat's first line names the item: that's how its ticket finds the chat (agentChatItem).
  // A short name for the agent: its chat's first line and its reports carry it, which links them.
  const agent = agentName(ctx.repository.current.flatMap((w) => w.chats.map((c) => agentChatItem(c.firstPrompt)?.agent ?? '')).filter(Boolean));
  await chatUi.newChat(chatContext(ctx), ws, agentPrompt(item, ticket, workstreamLabel(ws), agent, path.join(ctx.backlog.dir, GUIDE)), agentLead(item, agent));
  await ctx.tickets.addActivity(item.id, 'Flotilla', `Opened a chat for agent ${agent} in worktree \`${workstreamLabel(ws)}\`. It reports here.`);
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

/** Opens a Claude Code chat that helps write an item's ticket (title, description, acceptance criteria). */
async function writeBacklogItem(ctx: CommandContext, id: unknown): Promise<void> {
  if (typeof id !== 'string') return;
  const remote = ctx.integrations.issues().find((i) => i.id === id);
  if (remote) {
    void vscode.window.showInformationMessage(`${id} is written in its tracker.`, 'Open It').then((c) => c && vscode.env.openExternal(vscode.Uri.parse(remote.url)));
    return;
  }
  const item = (await ctx.backlog.read()).items.find((i) => i.id === id);
  if (!item) return;
  const ticket = await ctx.backlog.ensureDocument(item);
  // The ticket tab shows Claude's edits as they're saved.
  await ctx.tickets.open(item.id);
  await chatUi.askClaude(
    [
      `Help me write backlog item ${item.id} as a clear ticket. The ticket is ${ticket}: "# <title>", the description, then an "## Activity" log (leave that alone).`,
      `Read what's there (my notes so far), ask me what you need to know, and look at this repository's code where it helps. Then rewrite the title and description: the problem or goal, the context, and acceptance criteria as a checklist.`,
      '',
    ].join('\n\n'),
  );
}

async function runSetupNow(ctx: CommandContext, dir: string): Promise<void> {
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  ctx.output.appendLine(copied.length ? `Copied into ${dir}: ${copied.join(', ')}` : `No setup files to copy into ${dir}.`);
  if (!settings.setupCommand.trim()) {
    if (!copied.length) void vscode.window.showInformationMessage('Nothing to do: set flotilla.copyFiles or flotilla.setupCommand.');
    return;
  }
  startSetupTerminal(dir, settings.setupCommand);
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
  const options = [...new Set([defaultBase, ...branches.local, ...branches.remote])].filter(
    (b): b is string => b !== undefined && b !== ws.worktree.branch,
  );
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

async function removeWorkstream(ctx: CommandContext, ws: Workstream): Promise<void> {
  const wt = ws.worktree;
  if (wt.isMain) {
    void vscode.window.showWarningMessage('The main worktree cannot be removed.');
    return;
  }
  if (!wt.path) return forgetWorkstream(ctx, ws);
  const risks = await ctx.service.removalRisks(wt);
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
  if (ws.isCurrent) {
    await ctx.extension.globalState.update(PENDING_REMOVAL_KEY, plan);
    try {
      await openWorktree(ctx, plan.mainRoot, false);
    } catch (error) {
      await ctx.extension.globalState.update(PENDING_REMOVAL_KEY, undefined);
      throw error;
    }
    return;
  }
  await executeRemoval(ctx, plan);
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
  if (extraWorkspaceFolder(wt.path)) removeWorkspaceFolder(wt.path);
  await ctx.service.remove(wt, { force: plan.force });
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
