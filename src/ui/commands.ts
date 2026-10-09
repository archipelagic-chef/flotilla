import * as path from 'node:path';
import * as vscode from 'vscode';
import { openChangeDiff } from '../core/diff/openDiff';
import { GitError } from '../core/git/gitCli';
import { samePath } from '../core/paths';
import type { Repository } from '../core/repository';
import { toWorkspaceUri } from '../core/uris';
import type { CompareMode } from '../features/diffs/compare';
import { clearAgentStatus } from '../features/workstreams/agentStatus';
import { resolveBase } from '../features/workstreams/progress';
import type { Workstream } from '../features/workstreams/workstream';
import { branchNameProblem } from '../features/worktrees/layout';
import { copySetupFiles } from '../features/worktrees/setup';
import type { CreateRequest, WorktreeService } from '../features/worktrees/worktreeService';
import { claudeHookConfig } from './claudeHooks';
import { describeWorkstream, workstreamLabel } from './format';
import { maybeOfferHygiene } from './hygiene';
import { removalToRun, setupsToRun, withoutSetup, type PendingRemoval, type PendingSetup } from './pending';
import { readSettings } from './settings';
import type { Node, WorkstreamsView } from './workstreamsView';

export interface CommandContext {
  extension: vscode.ExtensionContext;
  service: WorktreeService;
  repository: Repository<Workstream>;
  view: WorkstreamsView;
  /** URI of this window's workspace folder; keeps scheme and remote authority. */
  reference: vscode.Uri;
  /** Root of the worktree open in this window. */
  currentRoot: string;
  output: vscode.OutputChannel;
}

const PENDING_REMOVAL_KEY = 'switchyard.pendingRemoval';
const PENDING_SETUP_KEY = 'switchyard.pendingSetup';

interface PickFilter {
  includeUnreachable?: boolean;
  excludeMain?: boolean;
}

type Handler = (...args: any[]) => unknown;

export async function openWorktree(ctx: CommandContext, dir: string, newWindow: boolean): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', toWorkspaceUri(ctx.reference, dir), { forceNewWindow: newWindow });
}

export function registerCommands(ctx: CommandContext): void {
  const register = (id: string, handler: Handler) => ctx.extension.subscriptions.push(vscode.commands.registerCommand(id, guard(ctx, handler)));
  const withWs =
    (handler: (ws: Workstream) => unknown, filter: PickFilter = {}) =>
    async (node?: Node) => {
      const ws = await pickWorkstream(ctx, node, filter);
      if (ws) await handler(ws);
    };

  register('switchyard.refresh', () => ctx.repository.refresh());
  register('switchyard.newWorkstream', () => newWorkstream(ctx));
  register('switchyard.quickSwitch', () => quickSwitch(ctx));
  register('switchyard.openInNewWindow', withWs((ws) => openWorktree(ctx, ws.worktree.path!, true)));
  register('switchyard.switchHere', withWs((ws) => openWorktree(ctx, ws.worktree.path!, false)));
  register('switchyard.remove', withWs((ws) => removeWorkstream(ctx, ws), { includeUnreachable: true, excludeMain: true }));
  register(
    'switchyard.adopt',
    withWs(
      async (ws) => {
        await ctx.service.adopt(ws.worktree);
        void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
        await ctx.repository.refresh();
      },
      { excludeMain: true },
    ),
  );
  register('switchyard.runSetupHere', withWs((ws) => runSetupNow(ctx, ws.worktree.path!), { excludeMain: true }));
  register('switchyard.openTerminal', withWs((ws) => vscode.window.createTerminal({ name: workstreamLabel(ws), cwd: ws.worktree.path }).show()));
  register('switchyard.copyPath', withWs((ws) => vscode.env.clipboard.writeText(ws.worktree.path!)));
  register('switchyard.revealInOS', withWs((ws) => vscode.commands.executeCommand('revealFileInOS', toWorkspaceUri(ctx.reference, ws.worktree.path!))));
  register('switchyard.compareWith', withWs((ws) => compareWith(ctx, ws)));
  register('switchyard.compareToggleTwoDot', (node?: Node) => toggleCompareMode(ctx, node, 'twoDot'));
  register('switchyard.compareToggleUncommitted', (node?: Node) => toggleCompareMode(ctx, node, 'uncommitted'));
  register('switchyard.compareDismiss', (node?: Node) => {
    if (node?.type === 'compare') ctx.view.setCompare(node.ws.key, undefined);
  });
  register('switchyard.openFileDiff', (node?: Node) => {
    if (node?.type === 'file' && node.ws.worktree.path) {
      return openChangeDiff(ctx.reference, node.ws.worktree.path, node.change, node.leftRef, node.rightRef, node.label);
    }
  });
  register('switchyard.openFile', (node?: Node) => openFile(ctx, node));
  register(
    'switchyard.clearAgentStatus',
    withWs(
      async (ws) => {
        await clearAgentStatus(ws.worktree.adminDir);
        await ctx.repository.refresh();
      },
      { includeUnreachable: true },
    ),
  );
  register('switchyard.copyClaudeHookConfig', async () => {
    await vscode.env.clipboard.writeText(claudeHookConfig());
    void vscode.window.showInformationMessage(
      'Claude Code hook config copied. Merge it into the "hooks" section of .claude/settings.json (project) or ~/.claude/settings.json (user).',
    );
  });
}

export async function resumePendingActions(ctx: CommandContext): Promise<void> {
  const state = ctx.extension.globalState;
  const now = Date.now();
  const queue = state.get<PendingSetup[]>(PENDING_SETUP_KEY, []);
  const setups = setupsToRun(queue, ctx.currentRoot, now);
  if (setups.keep.length !== queue.length) {
    await state.update(PENDING_SETUP_KEY, setups.keep);
    for (const p of setups.run) startSetupTerminal(p.worktreeDir, p.command);
  }
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

async function pickWorkstream(ctx: CommandContext, node: Node | undefined, filter: PickFilter): Promise<Workstream | undefined> {
  if (node?.type === 'workstream') return node.ws;
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

type SourceItem = vscode.QuickPickItem & { value: CreateRequest['kind'] };

async function newWorkstream(ctx: CommandContext): Promise<void> {
  const source = await vscode.window.showQuickPick<SourceItem>(
    [
      { label: '$(add) New branch…', value: 'new' },
      { label: '$(git-branch) Existing local branch', value: 'existing' },
      { label: '$(cloud) Remote branch', value: 'remote' },
    ],
    { title: 'New workstream' },
  );
  if (!source) return;
  const branches = await ctx.service.listBranches();
  let request: CreateRequest;
  if (source.value === 'new') {
    const branch = await vscode.window.showInputBox({
      title: 'New branch name',
      prompt: 'The worktree folder is named after the branch.',
      validateInput: (value) => branchNameProblem(value, branches.local),
    });
    if (!branch) return;
    const startPoint = await vscode.window.showQuickPick(['HEAD', ...branches.local, ...branches.remote], { title: `Start '${branch}' from…` });
    if (!startPoint) return;
    request = { kind: 'new', branch, startPoint };
  } else if (source.value === 'existing') {
    const checkedOut = new Set(ctx.repository.current.map((ws) => ws.worktree.branch));
    const free = branches.local.filter((b) => !checkedOut.has(b));
    if (free.length === 0) {
      void vscode.window.showInformationMessage('Every local branch is already checked out in a worktree.');
      return;
    }
    const branch = await vscode.window.showQuickPick(free, { title: 'Branch to check out' });
    if (!branch) return;
    request = { kind: 'existing', branch };
  } else {
    if (branches.remote.length === 0) {
      void vscode.window.showInformationMessage('No remote branches found. Run git fetch first.');
      return;
    }
    const remoteRef = await vscode.window.showQuickPick(branches.remote, { title: 'Remote branch' });
    if (!remoteRef) return;
    request = { kind: 'remote', remoteRef };
  }

  const created = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating worktree…' },
    () => ctx.service.create(request),
  );
  const dir = created.path!;
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  if (copied.length) ctx.output.appendLine(`Copied into ${dir}: ${copied.join(', ')}`);
  await ctx.repository.refresh();
  if (settings.openAfterCreate !== 'currentWindow') void maybeOfferHygiene(ctx.extension, ctx.service.roots.mainRoot);
  if (settings.openAfterCreate === 'none') {
    startSetupTerminal(dir, settings.setupCommand);
    return;
  }
  const queued = await queueSetup(ctx, dir, settings.setupCommand);
  try {
    await openWorktree(ctx, dir, settings.openAfterCreate === 'newWindow');
  } catch (error) {
    if (queued) {
      const queue = ctx.extension.globalState.get<PendingSetup[]>(PENDING_SETUP_KEY, []);
      await ctx.extension.globalState.update(PENDING_SETUP_KEY, withoutSetup(queue, queued));
    }
    throw error;
  }
}

async function runSetupNow(ctx: CommandContext, dir: string): Promise<void> {
  const settings = readSettings();
  const copied = await copySetupFiles(ctx.service.roots.mainRoot, dir, settings.copyFiles);
  ctx.output.appendLine(copied.length ? `Copied into ${dir}: ${copied.join(', ')}` : `No setup files to copy into ${dir}.`);
  if (!settings.setupCommand.trim()) {
    if (!copied.length) void vscode.window.showInformationMessage('Nothing to do: set switchyard.copyFiles or switchyard.setupCommand.');
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

async function queueSetup(ctx: CommandContext, dir: string, command: string): Promise<PendingSetup | undefined> {
  if (!command.trim()) return undefined;
  const entry: PendingSetup = { worktreeDir: dir, command, createdAt: Date.now() };
  const queue = ctx.extension.globalState.get<PendingSetup[]>(PENDING_SETUP_KEY, []);
  await ctx.extension.globalState.update(PENDING_SETUP_KEY, [...queue, entry]);
  return entry;
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
  ctx.view.setCompare(ws.key, { base, mode: 'mergeBase' });
}

function toggleCompareMode(ctx: CommandContext, node: Node | undefined, mode: Exclude<CompareMode, 'mergeBase'>): void {
  if (node?.type !== 'compare') return;
  ctx.view.setCompare(node.ws.key, { ...node.compare, mode: node.compare.mode === mode ? 'mergeBase' : mode });
}

async function openFile(ctx: CommandContext, node: Node | undefined): Promise<void> {
  if (node?.type !== 'file' || !node.ws.worktree.path) return;
  if (node.change.kind === 'deleted') {
    void vscode.window.showInformationMessage(`${node.change.path} was deleted.`);
    return;
  }
  await vscode.window.showTextDocument(toWorkspaceUri(ctx.reference, path.join(node.ws.worktree.path, node.change.path)));
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
