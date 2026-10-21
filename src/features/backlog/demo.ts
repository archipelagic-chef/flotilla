/**
 * A ticket's demo (BL-135): the proof that it's delivered, in a section of its own. The latest recording among its
 * attachments (BL-110 marks the demos), the round it was recorded in, the `run demo` block that plays it, how many
 * commits came after it (then it shows the work as it was before them), and the earlier recordings. Pure: the ticket
 * gives its attachments, activity and commits.
 */
import { entryAgent } from './backlog';
import { parseVerdict } from './review';
import { parseRunBlocks } from './runBlocks';

export interface DemoAttachment {
  demo: boolean;
  /** "YYYY-MM-DD HH:MM" (local), as the entry that added it, or the file's. */
  date?: string;
  /** The entry that added it. */
  entryKey?: string;
}

export interface DemoEntry {
  key?: string;
  date: string;
  author: string;
  body: string;
}

export interface DemoCommit {
  /** ISO 8601. */
  date: string;
  subject: string;
}

export interface TicketDemo<A> {
  latest: A;
  /** The earlier recordings, newest first. */
  earlier: A[];
  /** The review round it was recorded in: 1 before the first review, 2 after it asked for changes, … */
  round?: number;
  /** The `run demo` block that plays it: its entry's, else the activity's latest. */
  run?: { key: string; index: number; name: string };
  /** The commits made after it was recorded (merges of the base aside). */
  since: number;
}

/** A local "YYYY-MM-DD HH:MM" (or an ISO date) as the minute it's in, for comparing; NaN when it isn't a date. */
function minute(date: string): number {
  const local = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/.exec(date.trim());
  const ms = local ? new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5]).getTime() : new Date(date).getTime();
  return Math.floor(ms / 60_000);
}

// Bringing the base in ("BL-3: Merge main", "Merge branch 'main'") doesn't change what the demo shows.
const MERGE = /^(?:[A-Za-z]+-\d+:\s*)?Merge\b/;

/** The `run demo` blocks of an entry, with their index among its run blocks. */
function demoBlocks(entry: DemoEntry): Array<{ key: string; index: number; name: string }> {
  if (!entry.key) return [];
  const key = entry.key;
  return parseRunBlocks(entry.body).flatMap((b, index) => {
    const name = b.kind === 'demo' ? b.title?.split(/\s+/)[0] : undefined;
    return name && /^[\w-]+$/.test(name) ? [{ key, index, name }] : [];
  });
}

/** The ticket's demo, or undefined when it has none. `attachments` are newest first, as gatherAttachments gives them. */
export function ticketDemo<A extends DemoAttachment>(
  attachments: readonly A[],
  entries: readonly DemoEntry[],
  commits: readonly DemoCommit[],
): TicketDemo<A> | undefined {
  const demos = attachments.filter((a) => a.demo);
  const latest = demos.find((a) => a.date) ?? demos[0];
  if (!latest) return undefined;
  const at = latest.entryKey === undefined ? -1 : entries.findIndex((e) => e.key === latest.entryKey);
  let round: number | undefined;
  if (at >= 0) {
    const reviews = entries.slice(0, at).flatMap((e) => (e.author === 'Flotilla' ? [Number(/^Review round (\d+):/.exec(e.body)?.[1] ?? 0)] : []));
    round = Math.max(0, ...reviews) + 1;
  }
  const run = (at >= 0 ? demoBlocks(entries[at]) : [])[0] ?? entries.flatMap(demoBlocks).pop();
  const recorded = latest.date ? minute(latest.date) : NaN;
  const since = Number.isNaN(recorded) ? 0 : commits.filter((c) => !MERGE.test(c.subject) && minute(c.date) > recorded).length;
  return { latest, earlier: demos.filter((a) => a !== latest), ...(round ? { round } : {}), ...(run ? { run } : {}), since };
}

// Code isn't read: an instruction quoted in a block isn't the agent saying so.
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;
const SEEN = /\b(?:demo|screenshots?|GIF|UI)\b/i;
// "No UI change", "doesn't change the UI", "without a demo", "UI unchanged", "no screenshot needed": a few words of
// the same clause apart, so "No crash. The UI is new." still speaks of the UI.
const WORD = /(?:demo|screenshots?|GIF|UI)\b/.source;
const NEGATED = new RegExp(
  String.raw`(?:\b(?:no|not|nothing|without|never|none)|n['’]t)\b(?:[ \t]+[\w'’/-]+){0,3}?[ \t]+${WORD}` +
    String.raw`|\b${WORD}(?:[ \t]+[\w'’/-]+){0,2}?[ \t]+(?:unchanged|untouched|(?:is[ \t]+)?not[ \t]+needed|isn['’]t[ \t]+needed)\b`,
  'gi',
);

/** Whether an entry speaks of a demo, a screenshot, a GIF or the UI: outside code, and not to say there's none. */
function speaksOfDemo(body: string): boolean {
  return SEEN.test(body.replace(FENCE, '').replace(NEGATED, ''));
}

/**
 * Whether a ticket without a demo should have one: the work changes something you see or click, as the latest
 * implementer report or the latest reviewer's verdict says when it speaks of a demo, a screenshot, a GIF or the UI.
 * Earlier entries aren't read: a plan's or an old round's remark isn't what the work became.
 */
export function wantsDemo(entries: readonly Pick<DemoEntry, 'author' | 'body'>[]): boolean {
  const latest = entries.filter((e) => !!entryAgent(e.author)).reverse();
  const verdict = latest.find((e) => parseVerdict(e.body));
  const report = latest.find((e) => !parseVerdict(e.body));
  return [report, verdict].some((e) => !!e && speaksOfDemo(e.body));
}

/** "Recorded before the last 2 commits". */
export function staleNote(since: number): string {
  return since === 1 ? 'Recorded before the last commit' : `Recorded before the last ${since} commits`;
}

/** "0:12", "1:05". */
export function demoLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * How long a GIF plays, in seconds: the sum of its frames' delays (1/100 s each, in their Graphic Control Extensions).
 * Undefined when it isn't a GIF, or it's cut short.
 */
export function gifSeconds(bytes: Uint8Array): number | undefined {
  const text = String.fromCharCode(...bytes.subarray(0, 6));
  if ((text !== 'GIF87a' && text !== 'GIF89a') || bytes.length < 13) return undefined;
  // The colour table's size: 3 * 2^(n+1) bytes, after the screen descriptor, when its flag is set.
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let i = 13 + table(bytes[10]);
  let hundredths = 0;
  const skipBlocks = () => {
    while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1;
    i++;
  };
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x3b) return hundredths / 100;
    if (b === 0x21) {
      if (bytes[i + 1] === 0xf9 && i + 5 < bytes.length) hundredths += bytes[i + 4] | (bytes[i + 5] << 8);
      i += 2;
      skipBlocks();
    } else if (b === 0x2c) {
      if (i + 10 > bytes.length) return undefined;
      i += 10 + table(bytes[i + 9]) + 1;
      skipBlocks();
    } else return undefined;
  }
  return undefined;
}
