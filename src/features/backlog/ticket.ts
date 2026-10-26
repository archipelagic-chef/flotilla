/**
 * A backlog item's ticket: a Markdown file that people and agents both edit.
 *
 *   # Title
 *
 *   Description, in Markdown (images: ![](BL-3/screenshot.png)).
 *
 *   ## Activity
 *
 *   ### 2026-10-10 14:03 · You
 *   A comment.
 *
 *   ### 2026-10-10 14:10 · Agent
 *   A progress report.
 *
 * Everything before "## Activity" is the description; each "### <date> · <author>" heading under it starts an entry.
 *
 * A reply (BL-126) is an entry whose first line names the entry it answers, by that entry's anchor:
 *
 *   ### 2026-10-10 14:20 · You
 *   ↩ [Reply to Agent Nova-7, 2026-10-10 14:10](#2026-10-10-1410-agent-nova-7)
 *   The reply.
 */
export interface TicketEntry {
  /** As written: "YYYY-MM-DD HH:MM". */
  date: string;
  author: string;
  body: string;
}

export interface Ticket {
  title: string;
  description: string;
  activity: TicketEntry[];
}

const ACTIVITY = '## Activity';
const ENTRY = /^###\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\s*[·|-]\s*(.+?)\s*$/;

export function parseTicket(text: string, fallbackTitle = ''): Ticket {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  const heading = first >= 0 ? /^#\s+(.+?)\s*#*\s*$/.exec(lines[first]) : null;
  const body = heading ? lines.slice(first + 1) : lines;
  const at = body.findIndex((l) => l.trim().toLowerCase() === ACTIVITY.toLowerCase());
  const description = (at >= 0 ? body.slice(0, at) : body).join('\n').trim();
  const activity: TicketEntry[] = [];
  if (at >= 0) {
    let current: TicketEntry | undefined;
    const lead: string[] = [];
    for (const line of body.slice(at + 1)) {
      const m = ENTRY.exec(line);
      if (m) {
        if (current) activity.push({ ...current, body: current.body.trim() });
        current = { date: m[1].replace('T', ' ').slice(0, 16), author: m[2], body: '' };
      } else if (current) current.body += `${line}\n`;
      else lead.push(line);
    }
    if (current) activity.push({ ...current, body: current.body.trim() });
    // Text under "## Activity" before any entry (hand-written) is kept as an entry without author.
    const loose = lead.join('\n').trim();
    if (loose) activity.unshift({ date: '', author: '', body: loose });
  }
  return { title: heading?.[1] ?? fallbackTitle, description, activity };
}

export function formatTicket(ticket: Ticket): string {
  const parts = [`# ${ticket.title}`, ''];
  if (ticket.description.trim()) parts.push(ticket.description.trim(), '');
  if (ticket.activity.length) {
    parts.push(ACTIVITY, '');
    for (const e of ticket.activity) {
      if (e.date || e.author) parts.push(`### ${e.date} · ${e.author}`);
      parts.push(e.body.trim(), '');
    }
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

/** An entry's anchor before duplicates are told apart: its date and author ("2026-10-20-1604-you"). */
function anchorBase(e: Pick<TicketEntry, 'date' | 'author'>): string {
  const date = e.date.replace(/^(\d{4}-\d{2}-\d{2})[ T]?(\d{2}):?(\d{2})?.*$/, (_, d: string, h?: string, m?: string) => (h ? `${d}-${h}${m ?? ''}` : d));
  const author = e.author
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return [date, author].filter(Boolean).join('-') || 'entry';
}

/**
 * Each entry's anchor, a stable id to link and reply to it: its date and author, and "-2", "-3"… for the second and
 * later entries of the same minute and author. Entries are only appended, so an anchor stays as other entries and the
 * description are edited.
 */
export function entryAnchors(activity: ReadonlyArray<Pick<TicketEntry, 'date' | 'author'>>): string[] {
  const seen = new Map<string, number>();
  return activity.map((e) => {
    const base = anchorBase(e);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

const REPLY = /^\s*↩\s*\[([^\]]*)\]\(#([^)\s]+)\)\s*$/;

/** The line a reply starts with: it names and links the entry it answers. */
export function replyLine(parent: Pick<TicketEntry, 'date' | 'author'>, anchor: string): string {
  return `↩ [Reply to ${parent.author || 'Note'}${parent.date ? `, ${parent.date}` : ''}](#${anchor})`;
}

/** A reply's parent (the anchor its first line links) and its text without that line; undefined for other entries. */
export function parseReply(body: string): { to: string; label: string; text: string } | undefined {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() !== '');
  const m = at >= 0 ? REPLY.exec(lines[at]) : null;
  if (!m) return undefined;
  return {
    to: m[2],
    label: m[1].trim(),
    text: lines
      .slice(at + 1)
      .join('\n')
      .trim(),
  };
}

/** An entry's place in the threads: its anchor; for a reply, whom it answers and the top-level entry it shows under. */
export interface EntryThread {
  anchor: string;
  /** For a reply: the anchor it links, and that entry's author and date (as the reply line names them). */
  reply?: { to: string; author: string; date: string; label: string };
  /** For a reply whose parent is there: the index of the top-level entry it's grouped under (one level deep). */
  root?: number;
}

/** The threads of a ticket's activity (BL-126): replies go under their parent's top-level entry. */
export function entryThreads(activity: ReadonlyArray<TicketEntry>): EntryThread[] {
  const anchors = entryAnchors(activity);
  const index = new Map(anchors.map((a, i) => [a, i]));
  const parents = activity.map((e, i) => {
    const r = parseReply(e.body);
    const p = r ? index.get(r.to) : undefined;
    // Only an earlier entry is a parent: that rules out loops.
    return { r, p: p !== undefined && p < i ? p : undefined };
  });
  const rootOf = (i: number): number => {
    const p = parents[i].p;
    return p === undefined ? i : rootOf(p);
  };
  return activity.map((_, i) => {
    const { r, p } = parents[i];
    if (!r) return { anchor: anchors[i] };
    const parent = p !== undefined ? activity[p] : undefined;
    return {
      anchor: anchors[i],
      reply: { to: r.to, author: parent?.author ?? '', date: parent?.date ?? '', label: r.label },
      ...(p !== undefined ? { root: rootOf(p) } : {}),
    };
  });
}

/** The author of an entry that came from a comment on the ticket's pull request (BL-224): "<login> on GitHub". */
export function gitHubAuthor(login: string): string {
  return `${login} on GitHub`;
}

/** Whether an entry came from a comment on the ticket's pull request (BL-224). */
export function fromGitHub(author: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])? on GitHub$/.test(author.trim());
}

/** Whether an entry is a person's comment: yours, or one from the ticket's pull request (BL-224). */
export function byPerson(author: string): boolean {
  return author === 'You' || fromGitHub(author);
}

/** "YYYY-MM-DD HH:MM" in local time, as entries are dated. */
export function entryDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/**
 * The "**When it's done:**" lines a description opens with (BL-137): what the work does once done, as Markdown,
 * without the label; undefined when it has none. They run to the first blank line.
 */
export function whenItsDone(description: string): string | undefined {
  const m = /^[ \t]*(?:\*\*|__)When it(?:'|’)s done:?(?:\*\*|__):?[ \t]*([^]*?)(?:\r?\n[ \t]*\r?\n|(?![^]))/im.exec(description);
  const text = m?.[1].trim();
  return text || undefined;
}

/** What a card's hover says of a ticket: its "When it's done" lines on one line, or else its description's first line. */
export function cardSummaryOf(description: string): string | undefined {
  const done = whenItsDone(description);
  if (!done) return summaryOf(description);
  const line = done
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

/** The first line of a description, shortened, to show under an item's title. */
export function summaryOf(description: string): string | undefined {
  const line = description
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/^[\s>*#-]+|\[[ xX]\]\s*/g, '')
        .trim(),
    )
    .find(Boolean);
  return line && (line.length > 140 ? `${line.slice(0, 139)}…` : line);
}

/** A link to a file in a ticket ("src/a.ts#L10-L20", "src/a.ts:10"): its path, and the lines it points at. */
export function parseFileLink(href: string): { path: string; start?: number; end?: number } {
  let rest = href;
  let start: number | undefined;
  let end: number | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const m = /^L(\d+)(?:-L?(\d+))?$/i.exec(rest.slice(hash + 1));
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : undefined;
    }
    rest = rest.slice(0, hash);
  } else {
    const m = /^(.*?):(\d+)(?:[:-](\d+))?$/.exec(rest);
    // Not a Windows drive ("C:\\…").
    if (m && !/^[a-z]$/i.test(m[1])) {
      rest = m[1];
      start = Number(m[2]);
    }
  }
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // As written.
  }
  return { path: decoded.replace(/^\.\//, ''), ...(start ? { start } : {}), ...(end && start && end > start ? { end } : {}) };
}
