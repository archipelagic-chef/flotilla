import type { Question } from '../features/backlog/report';
import type { NoteView } from './protocol';
import type { TicketHostMessage, TicketWebviewMessage } from './ticketProtocol';

/** A sent note, as its tab shows it (BL-204): what you wrote, to edit, then its activity, then a box to write in. */
export interface NoteTabView {
  id: string;
  title: string;
  /** The note as written (Markdown). */
  text: string;
  status: NoteView['status'];
  /** The agent handling it, or that did. */
  agent?: string;
  /** Handled with another note, which leads: your comments go there. */
  with?: string;
  /** What it became, as its card says ("Became BL-180 (proposal)"), once it has. */
  became?: string;
  /** Its agent's replies, your answers and edits, Flotilla's lines, rendered. */
  activity: Array<{ author: string; date: string; html: string }>;
  /** What its agent asks, while it waits for you (BL-216): its questions, answered by clicking, as a ticket's. */
  asks?: { questions: Question[] };
}

/**
 * The New Note tab (BL-182): a note written as a comment is, with the formatting toolbar, Preview and pasted images.
 * Its Markdown box speaks the ticket's messages for images and previews; Send is its own.
 */
export type NoteWebviewMessage =
  | Extract<TicketWebviewMessage, { type: 'ready' | 'image' | 'preview' | 'mediaRefused' }>
  /** Sends the note to an agent (and closes the tab). */
  | { type: 'noteSend'; text: string }
  /** Saves your edit of a sent note (BL-204). */
  | { type: 'noteSave'; text: string }
  /** Writes a comment at the end of a sent note's activity (its answer, when it asks). */
  | { type: 'noteComment'; text: string }
  /** Opens the note that leads (a note handled with it). */
  | { type: 'noteOpen'; id: string };

export type NoteHostMessage =
  | Extract<TicketHostMessage, { type: 'imageSaved' | 'previewed' }>
  /** What the Mention button inserts: the backlog's ids' prefix ("BL-"); a sent note's tab, the note (BL-204). */
  | { type: 'noteInit'; mention: string; note?: NoteTabView }
  /** A sent note changed (its agent replied, its state moved, you saved): as it is now. */
  | { type: 'noteChanged'; note: NoteTabView }
  /** Answer (Needs you, BL-216) opened the tab again: its first question takes the focus. */
  | { type: 'noteFocus' }
  /** A save or a comment is done, or (with failed) why it isn't. */
  | { type: 'noteDone'; op: 'save' | 'comment'; failed?: string }
  /** The note was sent, or (with failed) why it wasn't. */
  | { type: 'noteSent'; failed?: string };
