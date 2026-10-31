import type { Tool, VcView } from '../protocol';

/**
 * Back from a file expanded in the ticket's tab (BL-211): the sidebar shows the Backlog again, if it's still on the
 * ticket's Changes that Expand switched it to; elsewhere (the user moved on), it stays where it is.
 */
export function backFromTicketChanges<T extends { tool: Tool; vcView: VcView }>(p: T): T {
  return p.tool === 'vc' && p.vcView === 'ticketChanges' ? { ...p, tool: 'backlog' } : p;
}
