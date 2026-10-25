import type { TicketHostMessage, TicketWebviewMessage } from './ticketProtocol';

/**
 * The New Note tab (BL-182): a note written as a comment is, with the formatting toolbar, Preview and pasted images.
 * Its Markdown box speaks the ticket's messages for images and previews; Send is its own.
 */
export type NoteWebviewMessage =
  | Extract<TicketWebviewMessage, { type: 'ready' | 'image' | 'preview' | 'mediaRefused' }>
  /** Sends the note to an agent (and closes the tab). */
  | { type: 'noteSend'; text: string };

export type NoteHostMessage =
  | Extract<TicketHostMessage, { type: 'imageSaved' | 'previewed' }>
  /** What the Mention button inserts: the backlog's ids' prefix ("BL-"). */
  | { type: 'noteInit'; mention: string }
  /** The note was sent, or (with failed) why it wasn't. */
  | { type: 'noteSent'; failed?: string };
