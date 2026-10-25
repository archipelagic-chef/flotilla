import type { BacklogItem } from './backlog';
import { STATUS_LABEL } from './changes';
import {
  entryAnchors,
  parseReply,
  summaryOf,
  type Ticket,
} from './ticket';

/**
 * References to other tickets and their comments (BL-130): a ticket's id ("BL-102", or a linked issue's key
 * "PROJ-12") and a comment's, its ticket's id and the entry's anchor ("BL-102#2026-10-20-1604-you", BL-126).
 */

/** An id in text: letters, then "-" and a number, on its own (not inside a word, a path or a longer id). */
const ID = /(?<![\w./#-])([A-Z][A-Z0-9]*-\d+)(?:#([a-z0-9][a-z0-9-]*))?(?![\w-])/g;

/** A link the ticket view opens as a reference: the ticket, and the entry in it. */
export const REFERENCE_LINK = 'flotilla-ref:';

export interface Reference {
  id: string;
  /** The comment's anchor in that ticket. */
  anchor?: string;
  /** Where it's written in the text, and how long it is. */
  index: number;
  length: number;
}

/** What a known reference shows on hover: undefined for an id that isn't a ticket (it stays text). */
export type ReferenceLookup = (id: string) => { id: string; title: string; status: string } | undefined;

/** The lookup of a backlog's items: by their ids, and by the keys of the issues they're linked to. */
export function referenceLookup(items: ReadonlyArray<Pick<BacklogItem, 'id' | 'title' | 'status' | 'links'>>): ReferenceLookup {
  const byId = new Map<string, { id: string; title: string; status: string }>();
  for (const i of items) for (const l of i.links ?? []) byId.set(l.id, { id: i.id, title: i.title, status: STATUS_LABEL[i.status] });
  for (const i of items) byId.set(i.id, { id: i.id, title: i.title, status: STATUS_LABEL[i.status] });
  return (id) => byId.get(id);
}

/** The references in plain text (no Markdown code in it) whose ids are known. */
function referencesInText(text: string, known: (id: string) => boolean, offset = 0): Reference[] {
  const found: Reference[] = [];
  for (const m of text.matchAll(ID)) {
    if (!known(m[1])) continue;
    found.push({ id: m[1], ...(m[2] ? { anchor: m[2] } : {}), index: offset + m.index, length: m[0].length });
  }
  return found;
}

/** Markdown with its code (fenced blocks, code spans) blanked out, so what's left keeps its places. */
function withoutCode(markdown: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.slice(open[0].length).trim()) fence = undefined;
        return blank(line);
      }
      if (open) {
        fence = open[1];
        return blank(line);
      }
      return line.replace(/(`+)(?!`).*?[^`]?\1(?!`)/g, blank);
    })
    .join('\n');
}

/** The references in Markdown whose ids are known, outside its code. */
export function findReferences(markdown: string, known: (id: string) => boolean): Reference[] {
  return referencesInText(withoutCode(markdown), known);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Elements whose text is never a reference: code, links (already one), and what isn't shown as text.
const SKIP = new Set(['code', 'pre', 'a', 'script', 'style', 'svg', 'textarea', 'kbd', 'samp']);

/**
 * Rendered html whose known references in text are links (`flotilla-ref:BL-102#anchor`), with the ticket's title and
 * status on hover. Text in code, in links and in attributes is left as it is; so are ids that aren't tickets.
 */
export function linkReferences(html: string, lookup: ReferenceLookup): string {
  const skipping: string[] = [];
  return html.replace(/(<[^>]*>)|([^<]+)/g, (part, tag: string | undefined, text: string | undefined) => {
    if (tag) {
      const m = /^<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>$/.exec(tag);
      const name = m?.[2].toLowerCase();
      if (m && name && SKIP.has(name) && !m[3]) {
        if (!m[1]) skipping.push(name);
        else if (skipping.lastIndexOf(name) >= 0) skipping.splice(skipping.lastIndexOf(name));
      }
      return part;
    }
    if (skipping.length || !text) return part;
    const refs = referencesInText(text, (id) => !!lookup(id));
    if (!refs.length) return part;
    let out = '';
    let at = 0;
    for (const r of refs) {
      const item = lookup(r.id)!;
      const href = `${REFERENCE_LINK}${item.id}${r.anchor ? `#${r.anchor}` : ''}`;
      const hover = `${item.id}: ${item.title} · ${item.status}${r.anchor ? '\nA comment in it' : ''}`;
      out += `${text.slice(at, r.index)}<a class="ticket-ref" href="${escapeHtml(href)}" title="${escapeHtml(hover)}">${text.slice(r.index, r.index + r.length)}</a>`;
      at = r.index + r.length;
    }
    return out + text.slice(at);
  });
}

/**
 * The ticket and entry a link in a ticket refers to, if it's a reference: `flotilla-ref:BL-102#anchor`, `BL-102`,
 * `BL-102#anchor`, `BL-102.md#anchor` (also with a path before it), or `#anchor` (an entry of the ticket it's in).
 * Whether the id is a ticket is the caller's to check.
 */
export function parseReferenceLink(href: string, self: string): { id: string; anchor?: string } | undefined {
  const rest = href.startsWith(REFERENCE_LINK) ? href.slice(REFERENCE_LINK.length) : href;
  if (rest.startsWith('#')) return rest.length > 1 ? { id: self, anchor: decodeURIComponent(rest.slice(1)) } : undefined;
  const m = /^(?:(?:\.{0,2}\/)?(?:[\w.-]+\/)*)?([A-Z][A-Z0-9]*-\d+)(\.md)?(?:#([^#\s]+))?$/.exec(rest);
  // A bare "BL-102#x", or a ticket's file: a path is only one with ".md".
  if (!m || (!m[2] && /\//.test(rest))) return undefined;
  return { id: m[1], ...(m[3] ? { anchor: decodeURIComponent(m[3]) } : {}) };
}

/** Where a ticket is mentioned in another one (BL-130): which ticket, which entry (none: its description), by whom. */
export interface Mention {
  /** The ticket it's written in. */
  from: string;
  /** The entry it's written in; undefined: in the description. */
  anchor?: string;
  author: string;
  date: string;
  /** The entry's first line, for the hover. */
  text?: string;
}

/**
 * The mentions of tickets in one ticket: one for each entry (or the description) that refers to a ticket other than
 * itself, by the ids it refers to. Flotilla's own notes aren't mentions: they name the tickets they wait for.
 */
export function mentionsIn(from: string, ticket: Ticket, known: (id: string) => boolean): Map<string, Mention[]> {
  const out = new Map<string, Mention[]>();
  const add = (refs: Reference[], mention: Mention) => {
    for (const id of new Set(refs.map((r) => r.id))) {
      if (id === from) continue;
      out.set(id, [...(out.get(id) ?? []), mention]);
    }
  };
  add(findReferences(ticket.description, known), { from, author: '', date: '' });
  const anchors = entryAnchors(ticket.activity);
  ticket.activity.forEach((e, i) => {
    if (e.author === 'Flotilla') return;
    const body = parseReply(e.body)?.text ?? e.body;
    const text = summaryOf(body);
    add(findReferences(body, known), { from, anchor: anchors[i], author: e.author, date: e.date, ...(text ? { text } : {}) });
  });
  return out;
}

/** The entry a comment's reference points at: its place in the activity, or undefined when it's gone. */
export function resolveEntry(ticket: Pick<Ticket, 'activity'>, anchor: string): number | undefined {
  const i = entryAnchors(ticket.activity).indexOf(anchor.toLowerCase());
  return i >= 0 ? i : undefined;
}
