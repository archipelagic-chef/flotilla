/** A ticket tab's messages about comments and the Markdown boxes: handled in ./comments.ts. Type-only, as ticketProtocol.ts. */
import type { MediaKind } from '../../../features/backlog/media';

export type CommentsMessage =
  /** replyTo: the anchor of the entry it answers (BL-126); ask: an agent answers it at once (BL-127). */
  | { type: 'comment'; text: string; replyTo?: string; ask?: boolean }
  /** Edit one of your comments (BL-128), by its anchor; delete it (after asking). */
  | { type: 'editComment'; anchor: string; text: string }
  | { type: 'deleteComment'; anchor: string }
  /** Ask an Agent (and Retry) on a comment of yours; now: Answer Now, a fresh agent instead of the busy implementer. Stop ends it. */
  | { type: 'askAgent'; anchor: string; now?: boolean }
  | { type: 'askAgentStop'; anchor: string }
  /** A pasted or dropped image or video, base64. */
  | { type: 'image'; requestId: number; name: string; data: string }
  /** A pasted or dropped file over its kind's size limit, not sent (the host says so). */
  | { type: 'mediaRefused'; name: string; kind: MediaKind; size: number }
  /** Renders a Markdown box's text for its Preview tab (BL-129); answered with previewed. */
  | { type: 'preview'; requestId: number; text: string }
  /** A ticket's entries to suggest (BL-130); answered with entries. */
  | { type: 'entries'; requestId: number; id: string }
  /** Puts a reference to an entry on the clipboard (BL-130). */
  | { type: 'copyText'; text: string }
  /** Post a local activity entry (an agent's report) to an issue, after asking. */
  | { type: 'postEntry'; key: string };
