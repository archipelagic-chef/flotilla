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
  const tabs = tabOrder(repository.current);
  if (typeof arg === 'number') {
    if (arg === 0) active.set(ALL);
    else if (tabs[arg - 1]) active.set(tabs[arg - 1].key);
    return;
  }
  if (typeof arg === 'string') {
    if (arg === ALL || tabs.some((w) => w.key === arg)) active.set(arg);
    return;
  }
  const now = new Date();
  type Item = vscode.QuickPickItem & { key: string };
  const items: Item[] = [
    { label: '$(layers) All worktrees', key: ALL },
    ...tabs.map((w, i) => ({ label: `${w.key === active.key ? '$(check) ' : ''}${workstreamLabel(w)}`, description: i < 9 ? `Ctrl+Alt+${i + 1}` : undefined, detail: describeWorkstream(w, now), key: w.key })),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Active worktree', placeHolder: 'Files, search, version control, chats and new terminals use the active worktree' });
  if (picked) active.set(picked.key);
}

const OFFERED_KEY = 'flotilla.activityBarOffered';

/** Offers (once, or on request) to hide VS Code's activity bar or move it to the top, so Flotilla's tool strip is the only one on the side. */
export async function offerActivityBar(context: vscode.ExtensionContext, force: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('workbench');
  const current = config.get<string>('activityBar.location');
  if (!force && (context.globalState.get<boolean>(OFFERED_KEY) || current === 'hidden' || current === 'top')) return;
  await context.globalState.update(OFFERED_KEY, true);
  const hide = 'Hide It';
  const top = 'Move to Top';
  const choice = await vscode.window.showInformationMessage(
    "Use Flotilla as your sidebar? Its tool strip replaces VS Code's activity bar. You can hide the activity bar, or move it to the top of the sidebar.",
    hide,
    top,
    'Not Now',
  );
  if (choice === hide) await config.update('activityBar.location', 'hidden', vscode.ConfigurationTarget.Global);
  else if (choice === top) await config.update('activityBar.location', 'top', vscode.ConfigurationTarget.Global);
}
