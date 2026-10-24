/** A ticket tab's messages about comments and the Markdown boxes: handled in ./comments.ts. Type-only, as ticketProtocol.ts. */
import type { MediaKind } from '../../../features/backlog/media';

export type CommentsMessage =
  /** replyTo: the anchor of the entry it answers (BL-126). */
  | { type: 'comment'; text: string; replyTo?: string }
  /** A pasted or dropped image or video, base64. */
  | { type: 'image'; requestId: number; name: string; data: string }
  /** A pasted or dropped file over its kind's size limit, not sent (the host says so). */
  | { type: 'mediaRefused'; name: string; kind: MediaKind; size: number }
  /** Renders a Markdown box's text for its Preview tab (BL-129); answered with previewed. */
  | { type: 'preview'; requestId: number; text: string }
  /** Post a local activity entry (an agent's report) to an issue, after asking. */
  | { type: 'postEntry'; key: string };
