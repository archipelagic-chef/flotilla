import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  mediaType,
  tooLarge,
  tooLargeNote,
} from '../../features/backlog/media';
import {
  askingEntry,
  becameText,
  noteQuestion,
  type NoteStore,
  withoutQuestions,
} from '../../features/backlog/notes';
import type {
  NoteHostMessage,
  NoteTabView,
  NoteWebviewMessage,
} from '../../webview/noteProtocol';
import type { NoteView } from '../../webview/protocol';
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
  /** A sent note's status, as its card says it (working while an agent has it). */
  status?(id: string): Promise<Pick<NoteView, 'status' | 'agent'> | undefined>;
  /** Opens another note's tab (the note that leads one handled with it). */
  open?(id: string): void;
}

/** The sent notes' tabs open, by note: opening one again shows it. */
const panels = new Map<string, vscode.WebviewPanel>();

/** Closes a sent note's tab, if it's open (its note was deleted, BL-215). */
export function closeNotePanel(id: string): void {
  panels.get(id)?.dispose();
}

/**
 * The New Note tab (BL-182): a draft note, written as a ticket's comment is (the formatting toolbar, Write and Preview,
 * pasted or dropped images, saved in the note's folder). Send writes it and sends it to an agent; closing the tab unsent
 * drops the draft and its images.
 *
 * With a sent note's id, its note tab (BL-204): the same editor with what you wrote, saved as an edit whatever the
 * note's state, then its activity and a box to write a comment in (its answer, when it asks).
 */
export async function openNotePanel(deps: NotePanelDeps, sentId?: string, answer = false): Promise<vscode.WebviewPanel> {
  const { notes } = deps;
  const shown = sentId && panels.get(sentId);
  if (shown) {
    shown.reveal();
    if (answer) void shown.webview.postMessage({ type: 'noteFocus' } satisfies NoteHostMessage);
    return shown;
  }
  const id = sentId ?? (await notes.draft());
  const dist = vscode.Uri.joinPath(deps.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('flotilla.note', sentId ?? 'New Note', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [dist, vscode.Uri.file(notes.dir)],
  });
  panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'flotilla.svg');
  panel.webview.html = html(panel.webview, dist);
  const post = (m: NoteHostMessage) => void panel.webview.postMessage(m);
  const view = async (): Promise<NoteTabView | undefined> => {
    const n = await notes.read(id);
    if (!n || n.status === 'draft') return undefined;
    const shownAs = await deps.status?.(id);
    const asks = noteQuestion(n);
    const asking = asks && askingEntry(n);
    return {
      id,
      title: n.title,
      text: n.text,
      status: shownAs?.status ?? n.status,
      ...((shownAs?.agent ?? n.agent) ? { agent: shownAs?.agent ?? n.agent } : {}),
      ...(n.with ? { with: n.with } : {}),
      ...(n.status === 'handled' || n.became.length ? { became: becameText(n.became) } : {}),
      activity: await Promise.all(
        n.activity.map(async (e) => ({
          author: e.author,
          date: e.date,
          // The question blocks of the reply that asks show as its choices, under the activity (BL-216).
          html: await renderMarkdown(asks?.questions.length && e === asking ? withoutQuestions(e.body) : e.body, panel.webview, notes.dir),
        })),
      ),
      ...(asks?.questions.length ? { asks: { questions: asks.questions } } : {}),
    };
  };
  const refresh = async () => {
    const note = await view();
    if (note) post({ type: 'noteChanged', note });
    // Deleted (in another window too, BL-215): its tab closes.
    else if (sentId && notes.wasDeleted(id) && !notes.exists(id)) panel.dispose();
  };
  let sent = !!sentId;
  if (sentId) panels.set(id, panel);
  const watch = sentId ? notes.watch(() => void refresh()) : undefined;
  panel.webview.onDidReceiveMessage(async (m: NoteWebviewMessage) => {
    try {
      switch (m.type) {
        case 'ready': {
          const note = sentId ? await view() : undefined;
          post({ type: 'noteInit', mention: deps.mention, ...(note ? { note } : {}) });
          return;
        }
        case 'noteSave':
          await notes.edit(id, m.text);
          deps.sent(id);
          post({ type: 'noteDone', op: 'save' });
          await refresh();
          return;
        case 'noteComment':
          if (!(await notes.comment(id, m.text))) throw new Error('The comment has no text.');
          deps.sent(id);
          post({ type: 'noteDone', op: 'comment' });
          await refresh();
          return;
        case 'noteOpen':
          deps.open?.(m.id);
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
      else if (m.type === 'noteSave' || m.type === 'noteComment') post({ type: 'noteDone', op: m.type === 'noteSave' ? 'save' : 'comment', failed });
      else void vscode.window.showErrorMessage(failed);
    }
  });
  panel.onDidDispose(() => {
    watch?.dispose();
    if (sentId) panels.delete(id);
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
