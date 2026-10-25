import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mediaType, tooLarge, tooLargeNote } from '../../features/backlog/media';
import type { NoteStore } from '../../features/backlog/notes';
import type { NoteHostMessage, NoteWebviewMessage } from '../../webview/noteProtocol';
import { renderMarkdown } from './ticketPanel';

export interface NotePanelDeps {
  extensionUri: vscode.Uri;
  notes: NoteStore;
  /** What the Mention button inserts (the backlog's ids' prefix). */
  mention: string;
  /** The note was sent: the lane shows it, and an agent may pick it up. */
  sent(id: string): void;
  /** The draft was dropped (the tab closed unsent). */
  dropped(id: string): void;
}

/**
 * The New Note tab (BL-182): a draft note, written as a ticket's comment is (the formatting toolbar, Write and Preview,
 * pasted or dropped images, saved in the note's folder). Send writes it and sends it to an agent; closing the tab unsent
 * drops the draft and its images.
 */
export async function openNotePanel(deps: NotePanelDeps): Promise<vscode.WebviewPanel> {
  const { notes } = deps;
  const id = await notes.draft();
  const dist = vscode.Uri.joinPath(deps.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('flotilla.note', 'New Note', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [dist, vscode.Uri.file(notes.dir)],
  });
  panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'flotilla.svg');
  panel.webview.html = html(panel.webview, dist);
  const post = (m: NoteHostMessage) => void panel.webview.postMessage(m);
  let sent = false;
  panel.webview.onDidReceiveMessage(async (m: NoteWebviewMessage) => {
    try {
      switch (m.type) {
        case 'ready':
          post({ type: 'noteInit', mention: deps.mention });
          return;
        case 'image': {
          const bytes = Buffer.from(m.data, 'base64');
          const kind = mediaType(m.name)?.kind ?? 'image';
          if (tooLarge(kind, bytes.length)) {
            post({ type: 'imageSaved', requestId: m.requestId, markdown: '' });
            void vscode.window.showWarningMessage(tooLargeNote(m.name, kind, bytes.length));
            return;
          }
          const rel = await notes.saveImage(id, m.name, bytes);
          post({ type: 'imageSaved', requestId: m.requestId, markdown: `![${path.basename(rel)}](${rel})` });
          return;
        }
        case 'preview':
          post({ type: 'previewed', requestId: m.requestId, html: await renderMarkdown(m.text, panel.webview, notes.dir) });
          return;
        case 'mediaRefused':
          void vscode.window.showWarningMessage(tooLargeNote(m.name, m.kind, m.size));
          return;
        case 'noteSend': {
          await notes.write(id, m.text);
          if (!(await notes.send(id))) {
            post({ type: 'noteSent', failed: 'The note has no text yet.' });
            return;
          }
          sent = true;
          deps.sent(id);
          panel.dispose();
          return;
        }
      }
    } catch (e) {
      const failed = e instanceof Error ? e.message : String(e);
      if (m.type === 'noteSend') post({ type: 'noteSent', failed });
      else void vscode.window.showErrorMessage(failed);
    }
  });
  panel.onDidDispose(() => {
    if (!sent) void notes.drop(id).then((dropped) => dropped && deps.dropped(id));
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
<link rel="stylesheet" href="${uri('note.css')}">
</head>
<body>
<div id="root" data-mermaid="${uri('mermaid.js')}"></div>
<script nonce="${nonce}" src="${uri('note.js')}"></script>
</body>
</html>`;
}
