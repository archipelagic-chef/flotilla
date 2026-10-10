import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveInside } from '../../core/paths';
import { toWorkspaceUri } from '../../core/uris';
import type { Target } from '../../webview/protocol';
import { FileOps } from './fileOps';
import type { SidebarProvider } from './sidebarProvider';

function isTarget(arg: unknown): arg is Target {
  return typeof arg === 'object' && arg !== null && typeof (arg as Target).key === 'string';
}

/** File commands of the Files tab; they get a Target from the webview's context menu or keyboard shortcuts. */
export function registerFileCommands(context: vscode.ExtensionContext, sidebar: SidebarProvider, reference: vscode.Uri, output: vscode.OutputChannel): void {
  const files = sidebar.files;
  const items = (t: Target) => (t.paths?.length ? t.paths : t.path ? [t.path] : []).map((p) => ({ key: t.key, path: p }));
  const fileUri = (t: Target) => {
    const root = sidebar.root(t.key);
    return root && t.path ? toWorkspaceUri(reference, resolveInside(root, t.path)) : undefined;
  };
  const register = (id: string, run: (t: Target) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown) => {
        if (!isTarget(arg)) return;
        try {
          await run(arg);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(message);
          void vscode.window.showErrorMessage(message);
        }
      }),
    );
  register('flotilla.newFile', (t) => files.startCreate(t, 'file'));
  register('flotilla.newFolder', (t) => files.startCreate(t, 'folder'));
  register('flotilla.renameFile', (t) => files.startRename(t));
  register('flotilla.deleteFile', (t) => files.delete(items(t)));
  register('flotilla.copyFile', (t) => files.setClipboard('copy', items(t)));
  register('flotilla.cutFile', (t) => files.setClipboard('cut', items(t)));
  register('flotilla.pasteFile', (t) => files.paste(t.key, FileOps.dirOf(t)));
  register('flotilla.copyRelativePath', (t) => vscode.env.clipboard.writeText(t.path ?? ''));
  register('flotilla.openToSide', (t) => {
    const uri = fileUri(t);
    if (uri) return vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  });
  register('flotilla.revealFileInOS', (t) => {
    const uri = fileUri(t);
    if (uri) return vscode.commands.executeCommand('revealFileInOS', uri);
  });
}
