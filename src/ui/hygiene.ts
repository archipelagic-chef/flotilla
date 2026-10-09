import * as vscode from 'vscode';
import { pathKey } from '../core/paths';

function valueAt<T>(config: vscode.WorkspaceConfiguration, key: string, target: vscode.ConfigurationTarget): T | undefined {
  const inspected = config.inspect<T>(key);
  const explicit = target === vscode.ConfigurationTarget.Global ? inspected?.globalValue : inspected?.workspaceValue;
  return explicit ?? inspected?.defaultValue;
}

async function apply(target: vscode.ConfigurationTarget): Promise<void> {
  const git = vscode.workspace.getConfiguration('git');
  const scan = valueAt<string[]>(git, 'repositoryScanIgnoredFolders', target) ?? [];
  if (!scan.includes('.worktrees')) await git.update('repositoryScanIgnoredFolders', [...scan, '.worktrees'], target);
  // Relative patterns resolve against each window's own folder, so a window opened on a worktree is unaffected.
  const excludes: Array<[string, string, string]> = [
    ['files', 'watcherExclude', '.worktrees/**'],
    ['search', 'exclude', '.worktrees'],
  ];
  for (const [section, key, glob] of excludes) {
    const config = vscode.workspace.getConfiguration(section);
    const current = valueAt<Record<string, boolean>>(config, key, target) ?? {};
    if (!current[glob]) await config.update(key, { ...current, [glob]: true }, target);
  }
}

export async function maybeOfferHygiene(extension: vscode.ExtensionContext, mainRoot: string): Promise<void> {
  const key = `switchyard.hygieneOffered:${pathKey(mainRoot)}`;
  if (extension.globalState.get<boolean>(key)) return;
  await extension.globalState.update(key, true);
  const user = 'User Settings (recommended)';
  const workspace = 'Workspace Settings';
  const choice = await vscode.window.showInformationMessage(
    'Hide .worktrees from search, file watching and the built-in Git repository scan?',
    user,
    workspace,
    'No',
  );
  if (choice === user) await apply(vscode.ConfigurationTarget.Global);
  else if (choice === workspace) await apply(vscode.ConfigurationTarget.Workspace);
}
