import * as path from 'node:path';
import * as vscode from 'vscode';
import { mediaType, tooLarge, tooLargeNote } from '../../../features/backlog/media';
import type { TicketHostMessage } from '../../../webview/ticketProtocol';
import { inMarkup, renderMarkdown } from '../ticketPanel';
import type { Handlers } from './context';

/** The activity: comments, the images and videos pasted into them, previews, and posting an entry to the tracker. */
export const commentsHandlers: Handlers = {
  comment: async ({ id, item, panels }, m) => {
    if (!m.text.trim()) return;
    if (item.remote) {
      await panels.writeRemote(id, (s) => s.comment(id, inMarkup(s, m.text)));
      return;
    } else {
      // A comment starts no agent by itself: Discuss opens a chat for that (BL-188).
      await panels.addActivity(id, 'You', await panels.withReplyLine(item, m.text, m.replyTo));
    }
  },
  editComment: async ({ id, panels }, m) => {
    if (m.text.trim()) await panels.changeComment(id, m.anchor, m.text);
  },
  deleteComment: async ({ id, panels }, m) => {
    await panels.changeComment(id, m.anchor, undefined);
  },
  image: async ({ id, panel, backlog }, m) => {
    const bytes = Buffer.from(m.data, 'base64');
    const kind = mediaType(m.name)?.kind ?? 'image';
    if (tooLarge(kind, bytes.length)) {
      void panel.webview.postMessage({ type: 'imageSaved', requestId: m.requestId, markdown: '' } satisfies TicketHostMessage);
      throw new Error(tooLargeNote(m.name, kind, bytes.length));
    }
    const rel = await backlog.saveImage(id, m.name, bytes);
    const reply: TicketHostMessage = { type: 'imageSaved', requestId: m.requestId, markdown: `![${path.basename(rel)}](${rel})` };
    void panel.webview.postMessage(reply);
  },
  preview: async ({ panel, item, panels }, m) => {
    const html = await renderMarkdown(m.text, panel.webview, panels.deps.backlog.dir, panels.roots(item));
    void panel.webview.postMessage({ type: 'previewed', requestId: m.requestId, html } satisfies TicketHostMessage);
  },
  mediaRefused: async (_, m) => {
    void vscode.window.showWarningMessage(tooLargeNote(m.name, m.kind, m.size));
  },
  postEntry: async ({ item, panels }, m) => {
    await panels.postEntry(item, m.key);
  },
};
