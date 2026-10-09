import * as vscode from 'vscode';

/** Builds a URI for a path in this environment that keeps the window's scheme and remote authority (works in devcontainers). */
export function toWorkspaceUri(reference: vscode.Uri, fsPath: string): vscode.Uri {
  return reference.with({ path: vscode.Uri.file(fsPath).path, query: '', fragment: '' });
}
