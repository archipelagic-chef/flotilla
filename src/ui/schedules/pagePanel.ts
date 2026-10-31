import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  PageHostMessage,
  PageWebviewMessage,
} from '../../webview/pageProtocol';
import { renderMarkdown } from '../backlog/ticketPanel';

export interface PagePanelDeps {
  extensionUri: vscode.Uri;
  /** Opens a link as a ticket's page does (TicketPanels.openHref, with no ticket). */
  openHref(href: string): Promise<void>;
}

/** The pages open, by file: opening one again shows it. */
const panels = new Map<string, vscode.WebviewPanel>();

/**
 * Opens a Markdown file as a page rendered as a ticket's entries are (BL-260): diagrams, links to files at their lines
 * and to tickets, images and videos in its folder. It follows the file as it changes (a run still writing it).
 */
export function openPagePanel(deps: PagePanelDeps, file: string, title: string): vscode.WebviewPanel {
  const shown = panels.get(file);
  if (shown) {
    shown.reveal();
    return shown;
  }
  const dist = vscode.Uri.joinPath(deps.extensionUri, 'dist');
  const dir = path.dirname(file);
  const panel = vscode.window.createWebviewPanel('flotilla.page', title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [dist, vscode.Uri.file(dir)],
  });
  panels.set(file, panel);
  panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'flotilla.svg');
  panel.webview.html = html(panel.webview, dist);
  const show = async () => {
    const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
    const page: PageHostMessage = { type: 'page', html: await renderMarkdown(text, panel.webview, dir) };
    void panel.webview.postMessage(page);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), path.basename(file)));
  watcher.onDidChange(() => void show());
  watcher.onDidCreate(() => void show());
  panel.webview.onDidReceiveMessage(async (m: PageWebviewMessage) => {
    if (m.type === 'ready') await show();
    else if (m.type === 'openHref') await deps.openHref(m.href).catch((e: unknown) => void vscode.window.showErrorMessage(String(e)));
  });
  panel.onDidDispose(() => {
    panels.delete(file);
    watcher.dispose();
  });
  return panel;
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(dist, ...p)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('page.css')}">
</head>
<body>
<div id="root" data-mermaid="${uri('mermaid.js')}"></div>
<script nonce="${nonce}" src="${uri('page.js')}"></script>
</body>
</html>`;
}
