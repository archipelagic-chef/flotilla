/** The audit of all sandboxed agents' tab (BL-272): their entries, filtered by ticket, agent, blocked or allowed. */
import type { AuditEntryView } from './ticketProtocol';

export interface AuditFilterView {
  ticket?: string;
  agent?: string;
  result?: 'blocked' | 'allowed';
}

/** To the tab: a page of the entries that match the filter, with their counts, and the tickets and agents to filter by. */
export type AuditHostMessage = {
  type: 'audit';
  entries: AuditEntryView[];
  total: number;
  blocked: number;
  allowed: number;
  filter: AuditFilterView;
  tickets: string[];
  agents: string[];
};

/** From the tab: it's ready, a new filter, the next page, or a ticket to open at its Audit section. */
export type AuditWebviewMessage = { type: 'ready' } | { type: 'filter'; filter: AuditFilterView } | { type: 'more' } | { type: 'openTicket'; id: string };
