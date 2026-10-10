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
 * Opens a terminal in a worktree: the active one, or, on the All tab (or when ask is set), the one picked from a list
 * of the reachable worktrees with the active one first. Without reachable worktrees it opens in fallbackCwd.
 */
export async function newTerminal(repository: Repository<Workstream>, active: ActiveWorktree, fallbackCwd: string | undefined, ask: boolean): Promise<void> {
  const reachable = tabOrder(repository.current).filter((w) => w.worktree.path);
  let ws = ask ? undefined : reachable.find((w) => w.key === active.key);
  if (!ws && reachable.length) {
    const now = new Date();
    type Item = vscode.QuickPickItem & { ws: Workstream };
    const items: Item[] = reachable
      .sort((a, b) => Number(b.key === active.key) - Number(a.key === active.key))
      .map((w) => ({ label: `$(git-branch) ${workstreamLabel(w)}`, description: w.key === active.key ? 'active' : undefined, detail: describeWorkstream(w, now), ws: w }));
    const picked = await vscode.window.showQuickPick(items, { title: 'New Terminal in Worktree', placeHolder: 'Which worktree should the terminal start in?' });
    if (!picked) return;
    ws = picked.ws;
  }
  const terminal = vscode.window.createTerminal({
    name: ws ? workstreamLabel(ws) : undefined,
    cwd: ws?.worktree.path ?? fallbackCwd,
    iconPath: ws ? new vscode.ThemeIcon('git-branch') : undefined,
  });
  terminal.show();
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
