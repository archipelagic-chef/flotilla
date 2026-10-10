import * as vscode from 'vscode';
import { samePath } from '../core/paths';
import { toWorkspaceUri } from '../core/uris';

/** The folder showing dir in this window's workspace, other than the window's own (first) folder. */
export function extraWorkspaceFolder(dir: string | undefined): vscode.WorkspaceFolder | undefined {
  if (!dir) return undefined;
  return vscode.workspace.workspaceFolders?.find((f) => f.index > 0 && samePath(f.uri.fsPath, dir));
}

/** Adds dir as a workspace folder named `name`. A single-folder window becomes an (untitled) multi-root workspace. */
export function addWorkspaceFolder(reference: vscode.Uri, dir: string, name: string): void {
  if (extraWorkspaceFolder(dir)) return;
  const at = vscode.workspace.workspaceFolders?.length ?? 0;
  if (!vscode.workspace.updateWorkspaceFolders(at, 0, { uri: toWorkspaceUri(reference, dir), name })) {
    throw new Error(`Could not add ${dir} to the workspace.`);
  }
}

export function removeWorkspaceFolder(dir: string | undefined): void {
  const folder = extraWorkspaceFolder(dir);
  if (folder && !vscode.workspace.updateWorkspaceFolders(folder.index, 1)) {
    throw new Error(`Could not remove ${folder.uri.fsPath} from the workspace.`);
  }
}
