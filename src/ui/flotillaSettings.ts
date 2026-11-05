import * as vscode from 'vscode';

/** What the Settings editor is filtered to: every Flotilla setting, in the groups of package.json's `configuration`. */
export const FLOTILLA_SETTINGS_QUERY = '@ext:archipelagic.flotilla';

/**
 * The sidebar's gear (BL-288): VS Code's Settings editor on Flotilla's settings. On the Workspace tab when a folder is
 * open, so a change is this repository's; without one, the User tab is all there is.
 */
export async function openFlotillaSettings(): Promise<void> {
  const command = vscode.workspace.workspaceFolders?.length ? 'workbench.action.openWorkspaceSettings' : 'workbench.action.openSettings';
  await vscode.commands.executeCommand(command, { query: FLOTILLA_SETTINGS_QUERY });
}
