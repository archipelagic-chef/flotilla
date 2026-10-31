/** A ticket tab's messages about the ticket itself: its title, description, status and priority, and how it shows: handled in ./ticket.ts. Type-only, as ticketProtocol.ts. */
import type {
  BacklogPriority,
  BacklogStatus,
} from '../../../features/backlog/backlog';

export type TicketMessage =
  | { type: 'ready' }
  | { type: 'title'; title: string }
  | { type: 'description'; text: string }
  | { type: 'status'; status: BacklogStatus }
  /** null clears it. */
  | { type: 'priority'; priority: BacklogPriority | null }
  | { type: 'accept' }
  | { type: 'dismiss' }
  /** Discard as won't do (asks first), and Reopen into To Do (BL-209). */
  | { type: 'discard' }
  | { type: 'reopen' }
  | { type: 'openTicket'; id: string }
  /** Keeps Flotilla's notes open (or shut) for the user, from now on. */
  | { type: 'showActivity'; shown: boolean }
  /** Folds (or opens) the ticket's Attachments section, for this ticket from now on. */
  | { type: 'foldAttachments'; folded: boolean }
  /** Plays every ticket's demos at this speed (BL-218), from now on. */
  | { type: 'demoSpeed'; speed: number };
