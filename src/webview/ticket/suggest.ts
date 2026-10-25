import type { BacklogStatus } from '../../features/backlog/backlog';
import type { EntrySuggestion } from '../ticketProtocol';
import type { TextEdit } from './format';

/**
 * What the comment box suggests as you type (BL-130): tickets after "#" or the ticket ids' prefix ("BL-"), and a
 * ticket's comments after its id and "#" ("BL-102#").
 */
export type SuggestQuery =
  /** Tickets: start is where what's replaced begins (the "#" or the prefix). */
  | { kind: 'ticket'; start: number; query: string }
  /** A ticket's entries: start is where its id begins. */
  | { kind: 'entry'; start: number; id: string; query: string };

export interface TicketSuggestion {
  id: string;
  title: string;
  status: BacklogStatus;
}

/** What to suggest for the text before the caret; undefined: nothing. */
export function suggestQuery(text: string, caret: number, prefix: string): SuggestQuery | undefined {
  const before = text.slice(0, caret);
  // Not in code: an odd number of "`" on the line, or an open fence.
  if (((before.slice(before.lastIndexOf('\n') + 1).match(/`/g) ?? []).length % 2) === 1) return undefined;
  if (((before.match(/^ {0,3}(```|~~~)/gm) ?? []).length % 2) === 1) return undefined;
  const entry = /(?:^|[\s([])([A-Z][A-Z0-9]*-\d+)#([\w-]*)$/.exec(before);
  if (entry) return { kind: 'entry', start: caret - entry[1].length - entry[2].length - 1, id: entry[1], query: entry[2] };
  const hash = /(?:^|[\s([])#([^\s#]*)$/.exec(before);
  // A Markdown heading's "# " isn't one: the query is what's typed right after the "#".
  if (hash) return { kind: 'ticket', start: caret - hash[1].length - 1, query: hash[1] };
  if (prefix) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const id = new RegExp(`(?:^|[\\s([])${escaped}(\\d*)$`).exec(before);
    if (id) return { kind: 'ticket', start: caret - prefix.length - id[1].length, query: prefix + id[1] };
  }
  return undefined;
}

const MAX = 8;

/** The tickets that match: by their id's start, then by their title (newest ids first). */
export function matchTickets(tickets: ReadonlyArray<TicketSuggestion>, query: string, self?: string): TicketSuggestion[] {
  const q = query.toLowerCase();
  const num = (id: string) => Number(/\d+$/.exec(id)?.[0] ?? 0);
  const others = tickets.filter((t) => t.id !== self).sort((a, b) => num(b.id) - num(a.id));
  const byId = others.filter((t) => t.id.toLowerCase().startsWith(q) || (/^\d+$/.test(q) && String(num(t.id)).startsWith(q)));
  const byTitle = q ? others.filter((t) => !byId.includes(t) && t.title.toLowerCase().includes(q)) : [];
  return [...byId, ...byTitle].slice(0, MAX);
}

/** A ticket's entries that match, by author, first line or anchor (newest first, as given). */
export function matchEntries(entries: ReadonlyArray<EntrySuggestion>, query: string): EntrySuggestion[] {
  const q = query.toLowerCase();
  return entries.filter((e) => !q || e.anchor.startsWith(q) || e.author.toLowerCase().includes(q) || e.text.toLowerCase().includes(q)).slice(0, MAX);
}

/** The edit that picks a suggestion: what was typed from start to the caret becomes the reference, and a space. */
export function pickSuggestion(text: string, caret: number, start: number, reference: string): TextEdit {
  const insert = /^\s/.test(text.slice(caret)) ? reference : `${reference} `;
  return { from: start, to: caret, insert, selStart: start + insert.length, selEnd: start + insert.length };
}
