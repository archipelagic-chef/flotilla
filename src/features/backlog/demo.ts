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
  /** The demo it was recorded from, as the recorder noted it in the file (BL-111). */
  recorded?: string;
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

/**
 * The `run demo` block a recording goes with (BL-111): the latest that names the demo it was recorded from, else its
 * entry's first, else the activity's latest.
 */
export function demoRunFor(a: DemoAttachment, entries: readonly DemoEntry[]): { key: string; index: number; name: string } | undefined {
  const all = entries.flatMap(demoBlocks);
  const named = a.recorded ? all.filter((b) => b.name === a.recorded).pop() : undefined;
  return named ?? all.find((b) => b.key === a.entryKey) ?? all.pop();
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
  const run = demoRunFor(latest, entries);
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

/** What a recording says it's a recording of (scripts/demo-kit.mjs's DEMO_TAG): in its GIF or MP4 comment. */
export const DEMO_TAG = 'flotilla-demo:';

/**
 * The demo a recording was recorded from (BL-111), as the recorder notes it in the file: its name, or undefined. Give it
 * the file's end (the recorder writes it there in a GIF; ffmpeg's MP4 has its metadata after the frames) or the whole.
 */
export function recordedDemo(bytes: Uint8Array): string | undefined {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const at = text.lastIndexOf(DEMO_TAG);
  return at < 0 ? undefined : /^[\w-]+/.exec(text.slice(at + DEMO_TAG.length))?.[0];
}

/** What a recording in a ticket is (BL-111): the demo it was recorded from, and how long it plays, when they're known. */
export interface Recording {
  name?: string;
  seconds?: number;
}

const DEMO_RUN = /<div class="run-block demo-run" data-demo="([\w-]+)">[\s\S]*?<\/div><\/div><!--\/demo-run-->/g;
const MEDIA = /<p\b[^>]*>\s*(<img\b[^>]*>|<video\b[^>]*><\/video>)\s*<\/p>/g;
const srcOf = (tag: string) => /\ssrc="([^"]*)"/.exec(tag)?.[1].replace(/&amp;/g, '&');

/** The speed control in a report's demo bar (BL-218): the webview marks the speed it plays at, and plays it so. */
function speedButtons(): string {
  const options = DEMO_SPEEDS.map(
    (s) =>
      `<button type="button" class="demo-speed-option" data-demo-speed="${s}" aria-pressed="${s === 1}" title="Play at ${speedLabel(s)}">${speedLabel(s)}</button>`,
  );
  return `<span class="demo-speed" role="group" aria-label="Speed">${options.join('')}</span>`;
}

/**
 * An entry's rendered html with each demo block (withRunButtons made it Try it yourself and Watch it live) put on the
 * recording it goes with, as one unit: "Recorded demo · 0:12" and the buttons over it, the block not shown again. A
 * recording goes with the block that names the demo it was recorded from; one that doesn't say, with the entry's only
 * block. `recording`: what a source (a recording of the ticket's) is; undefined for anything else.
 */
export function withDemoUnits(html: string, recording: (src: string) => Recording | undefined): string {
  const blocks = [...html.matchAll(DEMO_RUN)].map((m) => ({
    whole: m[0],
    name: m[1],
    actions: /<span class="demo-actions">([\s\S]*?)<\/span><\/div>/.exec(m[0])?.[1] ?? '',
  }));
  if (!blocks.length) return html;
  const media = [...html.matchAll(MEDIA)].flatMap((m) => {
    const src = srcOf(m[1]);
    const r = src === undefined ? undefined : recording(src);
    return r ? [{ whole: m[0], tag: m[1], ...r }] : [];
  });
  let out = html;
  const used = new Set<string>();
  for (const block of blocks) {
    const paired =
      media.find((m) => !used.has(m.whole) && m.name === block.name) ?? (blocks.length === 1 ? media.find((m) => !used.has(m.whole) && !m.name) : undefined);
    if (!paired) continue;
    used.add(paired.whole);
    // A video plays as a GIF does: muted (as every video is), looping; the view plays it while it's seen (BL-228).
    const shown = paired.tag.startsWith('<video') ? paired.tag.replace(/^<video\b/, '<video loop') : paired.tag;
    const label = demoLabel(paired.seconds);
    const unit =
      `<figure class="demo-unit demo-inline" data-demo="${block.name}"><div class="demo-bar">` +
      `<span class="demo-label"><i class="codicon codicon-device-camera-video"></i> <span class="demo-length"${paired.seconds ? ` data-seconds="${paired.seconds}"` : ''}>${label}</span></span>` +
      `${speedButtons()}${block.actions}</div>${shown}</figure>`;
    out = out.replace(paired.whole, () => unit).replace(block.whole, '');
  }
  return out;
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
 * A GIF's frames' delays, in milliseconds (1/100 s each, in their Graphic Control Extensions), as they're written: one
 * for each frame that has one. Undefined when it isn't a GIF, or it's cut short.
 */
export function gifDelays(bytes: Uint8Array): number[] | undefined {
  const text = String.fromCharCode(...bytes.subarray(0, 6));
  if ((text !== 'GIF87a' && text !== 'GIF89a') || bytes.length < 13) return undefined;
  // The colour table's size: 3 * 2^(n+1) bytes, after the screen descriptor, when its flag is set.
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let i = 13 + table(bytes[10]);
  const delays: number[] = [];
  const skipBlocks = () => {
    while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1;
    i++;
  };
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x3b) return delays;
    if (b === 0x21) {
      if (bytes[i + 1] === 0xf9 && i + 5 < bytes.length) delays.push((bytes[i + 4] | (bytes[i + 5] << 8)) * 10);
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

/** How long a GIF plays, in seconds: the sum of its frames' delays. Undefined when it isn't a GIF, or it's cut short. */
export function gifSeconds(bytes: Uint8Array): number | undefined {
  const delays = gifDelays(bytes);
  return delays && delays.reduce((sum, d) => sum + d, 0) / 1000;
}

/** The speeds a demo plays at (BL-218): as recorded, or faster. */
export const DEMO_SPEEDS = [1, 1.5, 2] as const;
export type DemoSpeed = (typeof DEMO_SPEEDS)[number];

/** A kept speed as one of DEMO_SPEEDS: anything else (nothing kept yet, an old value) plays as recorded. */
export function demoSpeed(value: unknown): DemoSpeed {
  return DEMO_SPEEDS.find((s) => s === value) ?? 1;
}

/** "1×", "1.5×". */
export function speedLabel(speed: number): string {
  return `${speed}×`;
}

/**
 * How long a GIF's frame shows at a speed, in milliseconds: its delay divided by the speed. A delay of 10 ms or less
 * (none, too) is shown for 100 ms, as browsers show it at 1×.
 */
export function frameDelay(delay: number | undefined, speed: number): number {
  const shown = delay === undefined || delay <= 10 ? 100 : delay;
  return shown / speed;
}

/** "Recorded demo · 0:12": its length at the speed it plays at (0:12 at 2× is 0:06); just "Recorded demo" when unknown. */
export function demoLabel(seconds: number | undefined, speed = 1): string {
  return `Recorded demo${seconds ? ` · ${demoLength(seconds / speed)}` : ''}`;
}
