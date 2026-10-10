import * as path from 'node:path';
import * as vscode from 'vscode';
import { openChangeDiff, openChangesEditor } from '../core/diff/openDiff';
import { INDEX, WORKING } from '../core/diff/refs';
import { GitError } from '../core/git/gitCli';
import { isInside, resolveInside, samePath } from '../core/paths';
import type { Repository } from '../core/repository';
import { toWorkspaceUri } from '../core/uris';
import { compareWithBase, type CompareMode } from '../features/diffs/compare';
import * as scm from '../features/scm/operations';
import { clearAgentStatus } from '../features/workstreams/agentStatus';
import { resolveBase } from '../features/workstreams/progress';
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
