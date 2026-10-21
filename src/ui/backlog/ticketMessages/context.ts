import type * as vscode from 'vscode';
import type { LocalBacklog } from '../../../features/backlog/localBacklog';
import type { BacklogItem } from '../../../features/backlog/backlog';
import type { RemoteIssue } from '../../../features/backlog/sources/source';
import type { TicketWebviewMessage } from '../../../webview/ticketProtocol';
import type { TicketPanels } from '../ticketPanel';

/** What a handler of a ticket tab's message works with: the ticket, its tab, and the panels that show it. */
export interface MessageContext {
  id: string;
  panel: vscode.WebviewPanel;
  item: BacklogItem & { remote?: RemoteIssue };
  backlog: LocalBacklog;
  panels: TicketPanels;
}

/** Handlers of a group of a ticket tab's messages, by type. */
export type Handlers = {
  [T in TicketWebviewMessage['type']]?: (c: MessageContext, m: Extract<TicketWebviewMessage, { type: T }>) => Promise<void>;
};
