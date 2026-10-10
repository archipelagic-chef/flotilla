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

/** "YYYY-MM-DD HH:MM" in local time, as entries are dated. */
export function entryDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** The first line of a description, shortened, to show under an item's title. */
export function summaryOf(description: string): string | undefined {
  const line = description
    .split(/\r?\n/)
    .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^[\s>*#-]+|\[[ xX]\]\s*/g, '').trim())
    .find(Boolean);
  return line && (line.length > 140 ? `${line.slice(0, 139)}…` : line);
}
