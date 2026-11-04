import type {
  BacklogPart,
  Tool,
} from '../protocol';

/**
 * Back from a file expanded in the ticket's tab (BL-211): the sidebar shows the Backlog's list again, if it's still on
 * the ticket's Changes that Expand switched it to, or its Commits that By commit did (BL-213, under the Backlog since
 * BL-275); elsewhere (the user moved on), it stays where it is.
 */
export function backFromTicketChanges<T extends { tool: Tool; backlogPart?: BacklogPart }>(p: T): T {
  return p.tool === 'backlog' && (p.backlogPart === 'changes' || p.backlogPart === 'commits') ? { ...p, backlogPart: 'list' } : p;
}
