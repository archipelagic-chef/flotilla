import * as vscode from 'vscode';
import type { Repository } from '../core/repository';
import type { Workstream } from '../features/workstreams/workstream';
import { ALL, type ActiveWorktree } from './activeWorktree';
import { describeWorkstream, workstreamLabel } from './format';
import { tabOrder } from './sidebar/viewModel';

/**
 * Makes a worktree the active one: by tab number (0 is All, 1… the worktree tabs, as with Ctrl+Alt+0…9),
 * by key, or picked from a list.
 */
export async function selectWorktree(arg: unknown, repository: Repository<Workstream>, active: ActiveWorktree): Promise<void> {
  const all = tabOrder(repository.current);
  // Ctrl+Alt+1…9 count the open tabs, as they appear.
  const tabs = all.filter((w) => active.isOpen(w.key));
  if (typeof arg === 'number') {
    if (arg === 0) active.set(ALL);
    else if (tabs[arg - 1]) active.set(tabs[arg - 1].key);
    return;
  }
  if (typeof arg === 'string') {
    if (arg === ALL || all.some((w) => w.key === arg)) active.set(arg);
    return;
  }
  const now = new Date();
  type Item = vscode.QuickPickItem & { key: string };
  const items: Item[] = [
    { label: '$(layers) All worktrees', key: ALL },
    ...all.map((w) => {
      const i = tabs.indexOf(w);
      const description = i < 0 ? 'tab closed' : i < 9 ? `Ctrl+Alt+${i + 1}` : undefined;
      return { label: `${w.key === active.key ? '$(check) ' : ''}${workstreamLabel(w)}`, description, detail: describeWorkstream(w, now), key: w.key };
    }),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Active worktree', placeHolder: 'Files, search, version control, chats and new terminals use the active worktree' });
  if (picked) active.set(picked.key);
}

/**
 * Where a new terminal starts: the active worktree, or, on the All tab (or when ask is set), the one picked from a
 * list of the reachable worktrees with the active one first. Without reachable worktrees it starts in fallbackCwd;
 * undefined when the pick is cancelled.
 */
export async function worktreeTerminalOptions(
  repository: Repository<Workstream>,
  active: ActiveWorktree,
  fallbackCwd: string | undefined,
  ask: boolean,
): Promise<vscode.TerminalOptions | undefined> {
  const reachable = tabOrder(repository.current).filter((w) => w.worktree.path);
  let ws = ask ? undefined : reachable.find((w) => w.key === active.key);
  if (!ws && reachable.length) {
    const now = new Date();
    type Item = vscode.QuickPickItem & { ws: Workstream };
    const items: Item[] = reachable
      .sort((a, b) => Number(b.key === active.key) - Number(a.key === active.key))
      .map((w) => ({ label: `$(git-branch) ${workstreamLabel(w)}`, description: w.key === active.key ? 'active' : undefined, detail: describeWorkstream(w, now), ws: w }));
    const picked = await vscode.window.showQuickPick(items, { title: 'New Terminal in Worktree', placeHolder: 'Which worktree should the terminal start in?' });
    if (!picked) return undefined;
    ws = picked.ws;
  }
  if (!ws) return { cwd: fallbackCwd };
  return { name: workstreamLabel(ws), cwd: ws.worktree.path, iconPath: new vscode.ThemeIcon('git-branch') };
}

export async function newTerminal(repository: Repository<Workstream>, active: ActiveWorktree, fallbackCwd: string | undefined, ask: boolean): Promise<void> {
  const options = await worktreeTerminalOptions(repository, active, fallbackCwd, ask);
  if (options) vscode.window.createTerminal(options).show();
}

/** The terminal profile VS Code's + button uses once it's the default profile (see useWorktreeTerminals). */
export const TERMINAL_PROFILE_ID = 'flotilla.worktreeTerminal';
export const TERMINAL_PROFILE_TITLE = 'Worktree (Flotilla)';

const TERMINALS_OFFERED_KEY = 'flotilla.worktreeTerminalsOffered';
const PLATFORM_KEY: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'osx', win32: 'windows' };

/** The setting that picks the default terminal profile where terminals run (the extension host's platform). */
function defaultProfileSetting(): string | undefined {
  const platform = PLATFORM_KEY[process.platform];
  return platform && `defaultProfile.${platform}`;
}

function usesWorktreeTerminals(): boolean {
  const key = defaultProfileSetting();
  return key !== undefined && vscode.workspace.getConfiguration('terminal.integrated').get<string>(key) === TERMINAL_PROFILE_TITLE;
}

/** Makes Flotilla's worktree profile the default, so VS Code's + button and Ctrl+Shift+` open terminals in the active worktree. */
export async function useWorktreeTerminals(context: vscode.ExtensionContext, confirm: boolean): Promise<void> {
  await context.globalState.update(TERMINALS_OFFERED_KEY, true);
  const key = defaultProfileSetting();
  if (!key) return;
  if (usesWorktreeTerminals()) {
    if (confirm) void vscode.window.showInformationMessage('New terminals already open in the active worktree.');
    return;
  }
  await vscode.workspace.getConfiguration('terminal.integrated').update(key, TERMINAL_PROFILE_TITLE, vscode.ConfigurationTarget.Global);
  if (confirm) {
    void vscode.window.showInformationMessage(
      `The terminal's + button now opens terminals in the active worktree (setting terminal.integrated.${key}). They use your default shell.`,
    );
  }
}

/**
 * Offers once, the first time a terminal opens in this window's folder while another worktree is active, to make +
 * open terminals in the active worktree.
 */
export function offerWorktreeTerminals(context: vscode.ExtensionContext, repository: Repository<Workstream>, active: ActiveWorktree): vscode.Disposable {
  return vscode.window.onDidOpenTerminal(async (terminal) => {
    if (context.globalState.get<boolean>(TERMINALS_OFFERED_KEY) || usesWorktreeTerminals()) return;
    const ws = repository.current.find((w) => w.key === active.key);
    const options = terminal.creationOptions as vscode.TerminalOptions;
    if (!ws?.worktree.path || ws.isCurrent || options.cwd !== undefined || options.name !== undefined) return;
    await context.globalState.update(TERMINALS_OFFERED_KEY, true);
    const choice = await vscode.window.showInformationMessage(
      `This terminal opened in the window's folder, not in '${workstreamLabel(ws)}', the active worktree. Should the terminal's + button open terminals in the active worktree?`,
      'Yes',
      'Not Now',
    );
    if (choice === 'Yes') await useWorktreeTerminals(context, true);
  });
}

const OFFERED_KEY = 'flotilla.activityBarOffered';

/** Offers (once, or on request) to hide VS Code's activity bar or move it to the top, so Flotilla's tool strip is the only one on the side. */
export async function offerActivityBar(context: vscode.ExtensionContext, force: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('workbench');
  const current = config.get<string>('activityBar.location');
  if (!force && (context.globalState.get<boolean>(OFFERED_KEY) || current === 'hidden' || current === 'top')) return;
  await context.globalState.update(OFFERED_KEY, true);
  const top = 'Move to Top (Recommended)';
  const hide = 'Hide It';
  const choice = await vscode.window.showInformationMessage(
    "Use Flotilla as your sidebar? Its tool strip replaces VS Code's activity bar, so you can move the activity bar to the top of the sidebar or hide it. " +
      'With it hidden, Ctrl+Shift+E, Ctrl+Shift+F and Ctrl+Shift+G open Flotilla, and so does its status bar item.',
    top,
    hide,
    'Not Now',
  );
  if (choice === hide) await config.update('activityBar.location', 'hidden', vscode.ConfigurationTarget.Global);
  else if (choice === top) await config.update('activityBar.location', 'top', vscode.ConfigurationTarget.Global);
}

/** Closes worktree tabs: the target's (or the active one's), or with others, every tab but the target's. */
export function closeTabs(arg: unknown, repository: Repository<Workstream>, active: ActiveWorktree, others: boolean): void {
  const key = typeof arg === 'object' && arg !== null && typeof (arg as { key?: unknown }).key === 'string' ? (arg as { key: string }).key : active.key;
  if (key === ALL) return;
  const order = tabOrder(repository.current).map((w) => w.key);
  if (others) {
    active.set(key);
    active.close(order.filter((k) => k !== key), order);
  } else {
    active.close([key], order);
  }
}
