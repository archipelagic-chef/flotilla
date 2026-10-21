import type { TicketWebviewMessage } from '../../../webview/ticketProtocol';
import type { MessageContext } from './context';
import { ticketHandlers } from './ticket';

export type { MessageContext } from './context';

/** Every handler, by message type: each group's module has its own. */
const HANDLERS = { ...ticketHandlers };

/** Handles a message of a ticket's tab by its group's handler (none for a message handled elsewhere, like the Ask chat's). */
export async function handleMessage(c: MessageContext, m: TicketWebviewMessage): Promise<void> {
  const handler = HANDLERS[m.type] as ((c: MessageContext, m: TicketWebviewMessage) => Promise<void>) | undefined;
  await handler?.(c, m);
}
