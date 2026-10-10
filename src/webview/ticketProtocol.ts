/**
 * Messages between the extension host and a ticket editor tab. Type-only: imported by both sides, so it must not
 * import vscode, node or DOM APIs.
 */
import type { BacklogItem, BacklogStatus } from '../features/backlog/backlog';
import type { TicketEntry } from '../features/backlog/ticket';
import type { AttentionState } from '../features/workstreams/attention';

export interface TicketView {
  item: BacklogItem;
  /** Markdown, for editing. */
  description: string;
  descriptionHtml: string;
  activity: Array<TicketEntry & { html: string }>;
  /** For an issue from an integration: where it lives. Its title, status and description are edited there. */
  remote?: { kind: 'jira' | 'github'; label: string; url: string; statusName: string };
  /** Reading it from its tracker failed. */
  error?: string;
  /** The worktrees working on the item (several for an epic), with their agents' state. */
  worktrees: Array<{ key: string; branch: string; attention: AttentionState; status: string; message?: string }>;
}

export type TicketHostMessage =
  | { type: 'ticket'; ticket: TicketView }
  /** An image was saved next to the ticket; markdown links it. */
  | { type: 'imageSaved'; requestId: number; markdown: string };

export type TicketWebviewMessage =
  | { type: 'ready' }
  | { type: 'title'; title: string }
  | { type: 'description'; text: string }
  | { type: 'comment'; text: string }
  | { type: 'status'; status: BacklogStatus }
  /** A pasted or dropped image, base64. */
  | { type: 'image'; requestId: number; name: string; data: string }
  /** Create (or show) the item's worktree; with agent, also start an agent there. */
  | { type: 'start'; agent: boolean }
  | { type: 'writeWithAI' }
  | { type: 'openFile' }
  | { type: 'openRemote' }
  | { type: 'openWorktree'; key: string };
