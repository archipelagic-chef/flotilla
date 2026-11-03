/** A discussion's tab (BL-267): a chat with an agent about the repository and its backlog, no ticket expected. */
import type { AskView } from '../features/backlog/ask';

export interface DiscussionTabView {
  id: string;
  title: string;
  chat: AskView;
  /** Pause All stopped it: writing goes on. */
  paused?: true;
  /** The tickets proposed from it (BL-268). */
  became?: string[];
  /** Its agent proposes tickets this turn (BL-268). */
  proposing?: true;
}

/** To the tab: the discussion, and a finished action (as a ticket's tab says it). */
export type DiscussionHostMessage = { type: 'discussion'; view: DiscussionTabView } | { type: 'done'; message: DiscussionWebviewMessage; failed?: boolean };

/** From the tab: the chat's messages (the Discuss pane's), Propose Tickets, rename and delete, and its links. */
export type DiscussionWebviewMessage =
  | { type: 'ready' }
  | { type: 'discussSend'; text: string }
  | { type: 'discussStop' }
  | { type: 'propose' }
  | { type: 'openTicket'; id: string }
  | { type: 'rename' }
  | { type: 'delete' }
  | { type: 'openHref'; href: string };
