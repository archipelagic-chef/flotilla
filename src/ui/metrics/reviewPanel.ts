import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toWorkspaceUri } from '../../core/uris';
import { parseReferenceLink } from '../../features/backlog/references';
import { parseFileLink } from '../../features/backlog/ticket';
import {
  reviewsDir,
  reviewTitle,
} from '../../features/metrics/review';
import type {
  ReviewHostMessage,
  ReviewWebviewMessage,
} from '../../webview/reviewProtocol';
import { renderMarkdown } from '../backlog/ticketPanel';

export interface ReviewPanelDeps {
  extensionUri: vscode.Uri;
  backlogDir: string;
  mainRoot: string;
  reference: vscode.Uri;
}

/** The review tabs open, by day: opening one again shows it. */
const panels = new Map<string, vscode.WebviewPanel>();

/**
 * An improvement review in a tab of its own (BL-177), rendered as a ticket's entries are: diagrams, links to files at
 * their lines, ticket references. It's drawn again as its file changes (while its agent writes it).
 */
export function openReviewPanel(deps: ReviewPanelDeps, day: string): vscode.WebviewPanel {
  const shown = panels.get(day);
  if (shown) {
    shown.reveal();
    return shown;
  }
  const dir = reviewsDir(deps.backlogDir);
  const file = path.join(dir, `${day}.md`);
  const dist = vscode.Uri.joinPath(deps.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('flotilla.review', `Review ${day}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [dist, vscode.Uri.file(deps.backlogDir)],
  });
  panels.set(day, panel);
  panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'flotilla.svg');
  panel.webview.html = html(panel.webview, dist);
  const post = async () => {
    const text = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
    const body = text?.replace(/^\s*#\s+.+\n/, '') ?? '';
    const message: ReviewHostMessage = {
      type: 'review',
      day,
      title: reviewTitle(text ?? '', day),
      html: text === undefined ? '' : await renderMarkdown(body, panel.webview, dir, [deps.mainRoot]),
      ...(text === undefined ? { missing: true } : {}),
    };
    void panel.webview.postMessage(message);
  };
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_e, name) => {
      if (name && String(name) !== `${day}.md`) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void post(), 500);
    });
    watcher.on('error', () => watcher?.close());
  } catch {
    // Not watched: it shows the review as it was when opened.
  }
  panel.webview.onDidReceiveMessage(async (m: ReviewWebviewMessage) => {
    try {
      if (m.type === 'ready') await post();
      else if (m.type === 'openHref') await openLink(deps.reference, m.href, [dir, deps.mainRoot, deps.backlogDir]);
      else if (m.type === 'openFile') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  });
  panel.onDidDispose(() => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    panels.delete(day);
  });
  return panel;
}

/**
 * A link of a review (or of a discussion's answer, BL-267): a ticket (or an entry of one), a web page, or a file, found
 * in the first of roots that has it.
 */
export async function openLink(reference: vscode.Uri, href: string, roots: readonly string[]): Promise<void> {
  const ref = parseReferenceLink(href, '');
  if (ref?.id) {
    await vscode.commands.executeCommand('flotilla.openBacklogItem', ref.id);
    return;
  }
  if (/^(https?|mailto):/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return;
  const link = parseFileLink(/^file:/i.test(href) ? vscode.Uri.parse(href).fsPath + (href.includes('#') ? href.slice(href.indexOf('#')) : '') : href);
  const found = (path.isAbsolute(link.path) ? [link.path] : roots.map((r) => path.join(r, link.path))).find((f) => fs.existsSync(f));
  if (!found) {
    void vscode.window.showWarningMessage(`${link.path} isn't there (anymore).`);
    return;
  }
  const uri = toWorkspaceUri(reference, found);
  if (fs.statSync(found).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const selection = link.start ? new vscode.Range(link.start - 1, 0, (link.end ?? link.start) - 1, link.end ? Number.MAX_SAFE_INTEGER : 0) : undefined;
  await vscode.commands.executeCommand('vscode.open', uri, { preview: true, ...(selection ? { selection } : {}) });
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
<link rel="stylesheet" href="${uri('review.css')}">
</head>
<body>
<div id="root" data-mermaid="${uri('mermaid.js')}"></div>
<script nonce="${nonce}" src="${uri('review.js')}"></script>
</body>
</html>`;
}
