import type { HandledTicketMessage, TicketWebviewMessage } from '../../../webview/ticketProtocol';
import type { Handlers, MessageContext } from './context';
import { agentsHandlers } from './agents';
import { checkHandlers } from './check';
import { commentsHandlers } from './comments';
import { filesHandlers } from './files';
import { mergeHandlers } from './merge';
import { reviewHandlers } from './review';
import { ticketHandlers } from './ticket';
import { trackerHandlers } from './tracker';

export type { MessageContext } from './context';

/** Every handler, by message type: each group's module has its own. */
const HANDLERS: Handlers<HandledTicketMessage> = {
  ...ticketHandlers,
  ...commentsHandlers,
  ...filesHandlers,
  ...trackerHandlers,
  ...agentsHandlers,
  ...reviewHandlers,
  ...mergeHandlers,
  ...checkHandlers,
};

/** Handles a message of a ticket's tab by its group's handler (none for a message handled elsewhere, like the Ask chat's). */
export async function handleMessage(c: MessageContext, m: TicketWebviewMessage): Promise<void> {
  const handler = (HANDLERS as Partial<Record<string, unknown>>)[m.type] as ((c: MessageContext, m: TicketWebviewMessage) => Promise<void>) | undefined;
  await handler?.(c, m);
}
