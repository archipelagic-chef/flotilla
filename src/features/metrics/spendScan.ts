import * as fs from 'node:fs';
import * as path from 'node:path';
import { encodeProjectDir } from '../chats/chats';
import { mergeRoot } from '../backlog/merge';
import {
  appendEvents,
  eventsDir,
  type FlotillaEvent,
} from './events';
import {
  type SpendHour,
  type SpendPart,
  type SpendPurpose,
  type TranscriptSpend,
  transcriptSpend,
} from './transcriptSpend';

/** What the scans counted so far, by transcript (its folder and file): its size and time then, and its last entry counted. */
export const STATE_FILE = 'spend-scan.json';
/** A chat that hasn't changed for this long is over (or idle): what's after its last cost record is counted at the price table's. */
export const IDLE_MS = 30 * 60_000;

/** A running chat's spend since its last cost record (BL-202): not recorded yet, but shown, priced from the table. */
export interface LiveSpend {
  session: string;
  ticket?: string;
  agent?: string;
  title?: string;
  cwd?: string;
  parts: Array<{ purpose: SpendPurpose; hours: SpendHour[] }>;
}

interface FileState {
  size: number;
  mtimeMs: number;
  last?: string;
  open?: true;
  live?: LiveSpend;
}

interface ScanState {
  files: Record<string, FileState>;
  /** The parts recorded keep their hours (BL-202): the hours of those recorded before were read in. */
  hours?: true;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const roundHours = (hours: readonly SpendHour[]): SpendHour[] => hours.map((h) => ({ ...h, costUsd: round(h.costUsd) }));
/** A chat's name and folder, for its events. */
const chatOf = (spend: TranscriptSpend) => ({ ...(spend.title ? { title: spend.title } : {}), ...(spend.cwd ? { cwd: spend.cwd } : {}) });
const liveOf = (session: string, spend: TranscriptSpend, parts: readonly SpendPart[]): LiveSpend => ({
  session,
  ...(spend.ticket ? { ticket: spend.ticket } : {}),
  ...(spend.agent ? { agent: spend.agent } : {}),
  ...chatOf(spend),
  parts: parts.filter((p) => p.hours.length).map((p) => ({ purpose: p.purpose, hours: roundHours(p.hours) })),
});

/**
 * The folders of Claude's transcripts of this repository's chats: its own, its worktrees', and the temporary merge
 * worktrees' (not other repositories nested in it).
 */
export async function projectDirs(home: string, mainRoot: string, tmp: string): Promise<Array<{ dir: string; ticket?: string }>> {
  const root = encodeProjectDir(mainRoot);
  const worktrees = `${root}--worktrees-`;
  const merges = encodeProjectDir(path.join(mergeRoot(tmp), `${path.basename(mainRoot)}-`));
  const names = await fs.promises.readdir(path.join(home, 'projects')).catch(() => [] as string[]);
  const out: Array<{ dir: string; ticket?: string }> = [];
  for (const name of names.sort()) {
    const rest =
      name === root ? '' : name.startsWith(worktrees) ? name.slice(worktrees.length) : name.startsWith(merges) ? name.slice(merges.length) : undefined;
    if (rest === undefined) continue;
    const ticket = /(?:^|-)([A-Z][A-Z0-9]*-\d+)(?=-|$)/.exec(rest)?.[1];
    out.push({ dir: path.join(home, 'projects', name), ...(ticket ? { ticket } : {}) });
  }
  return out;
}

async function readState(commonDir: string): Promise<ScanState | undefined> {
  try {
    const s = JSON.parse(await fs.promises.readFile(path.join(eventsDir(commonDir), STATE_FILE), 'utf8')) as ScanState;
    return s && typeof s.files === 'object' ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records what this repository's chats spent since the last scan (BL-189), as agent-spend events: each part of a chat,
 * once it's settled (its cost recorded, or the chat idle). The first scan reads in the history, marked imported.
 * Returns how many parts it recorded. home: Claude's (~/.claude); tmp: the OS's temp folder.
 */
export async function scanSpend(o: { commonDir: string; mainRoot: string; home: string; tmp: string; now?: number }): Promise<number> {
  const now = o.now ?? Date.now();
  const was = await readState(o.commonDir);
  const state: ScanState = { files: { ...was?.files }, hours: true };
  let recorded = 0;
  // A resumed chat's transcript repeats the old one's messages: each is counted once, in the transcript that has its cost.
  const seen = new Set<string>();
  const count = async (c: { key: string; name: string; ticket?: string; stat: fs.Stats; text: string }) => {
    const before = state.files[c.key];
    const idle = now - c.stat.mtimeMs > IDLE_MS;
    const spend = transcriptSpend(c.text, { after: before?.last, settled: idle, seen, ...(c.ticket ? { ticket: c.ticket } : {}) });
    const session = spend.session ?? c.name.replace(/\.jsonl$/, '');
    const events: FlotillaEvent<'agent-spend'>[] = spend.parts.map((p) => ({
      at: p.at,
      kind: 'agent-spend',
      ...(spend.ticket ? { ticket: spend.ticket } : {}),
      ...(spend.agent ? { agent: spend.agent } : {}),
      data: {
        session,
        purpose: p.purpose,
        to: p.to,
        tokens: p.tokens,
        costUsd: round(p.costUsd),
        contextK: p.contextK,
        tools: p.tools,
        ...(p.priced ? { priced: true as const } : {}),
        hours: roundHours(p.hours),
        ...chatOf(spend),
      },
      ...(was ? {} : { imported: true as const }),
    }));
    await appendEvents(o.commonDir, events);
    recorded += events.length;
    const last = spend.last ?? before?.last;
    const live = spend.live?.length ? liveOf(session, spend, spend.live) : undefined;
    state.files[c.key] = {
      size: c.stat.size,
      mtimeMs: c.stat.mtimeMs,
      ...(last ? { last } : {}),
      ...(spend.open ? { open: true as const } : {}),
      ...(live?.parts.length ? { live } : {}),
    };
    // Noted at once: a scan cut short doesn't record these parts again.
    if (events.length) await writeState(o.commonDir, state);
    // Out of the way of the window: a file at a time.
    await new Promise((resolve) => setImmediate(resolve));
  };
  const dirs = await projectDirs(o.home, o.mainRoot, o.tmp);
  // Scanned before the parts kept their hours: those of the parts recorded then are read in first, once.
  if (was && !was.hours) {
    await readHours(o.commonDir, dirs, was);
    await writeState(o.commonDir, state);
  }
  const later: Array<{ key: string; file: string; name: string; ticket?: string; stat: fs.Stats }> = [];
  for (const { dir, ticket } of dirs) {
    const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'));
    for (const name of names) {
      const key = `${path.basename(dir)}/${name}`;
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file).catch(() => undefined);
      if (!stat) continue;
      const before = state.files[key];
      // Unchanged since it was counted: nothing new, unless what waited for a cost record is settled now.
      if (before && before.size === stat.size && before.mtimeMs === stat.mtimeMs && !(before.open && now - stat.mtimeMs > IDLE_MS)) continue;
      const text = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const c = { key, name, ...(ticket ? { ticket } : {}), stat };
      // The transcripts with cost records first: the messages they share with others are counted at their cost.
      if (text.includes('"type":"cost-state"')) await count({ ...c, text });
      else later.push({ ...c, file });
    }
  }
  for (const c of later) {
    const text = await fs.promises.readFile(c.file, 'utf8').catch(() => undefined);
    if (text !== undefined) await count({ ...c, text });
  }
  await writeState(o.commonDir, state);
  return recorded;
}

/**
 * Records the hours of the parts the scans recorded before parts kept them (BL-202), as spend-hours events: each
 * transcript read up to the last entry counted then, the way those scans read it.
 */
async function readHours(commonDir: string, dirs: ReadonlyArray<{ dir: string; ticket?: string }>, was: ScanState): Promise<void> {
  const seen = new Set<string>();
  const later: Array<{ name: string; ticket?: string; last: string; text: string }> = [];
  const count = async (c: { name: string; ticket?: string; last: string; text: string }) => {
    const spend = transcriptSpend(c.text, { until: c.last, settled: true, seen, ...(c.ticket ? { ticket: c.ticket } : {}) });
    const session = spend.session ?? c.name.replace(/\.jsonl$/, '');
    const events: FlotillaEvent<'spend-hours'>[] = spend.parts
      .filter((p) => p.hours.length)
      .map((p) => ({
        at: p.at,
        kind: 'spend-hours',
        ...(spend.ticket ? { ticket: spend.ticket } : {}),
        ...(spend.agent ? { agent: spend.agent } : {}),
        data: { session, purpose: p.purpose, hours: roundHours(p.hours), ...chatOf(spend) },
        imported: true,
      }));
    await appendEvents(commonDir, events);
    await new Promise((resolve) => setImmediate(resolve));
  };
  for (const { dir, ticket } of dirs) {
    for (const name of (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'))) {
      const last = was.files[`${path.basename(dir)}/${name}`]?.last;
      if (!last) continue;
      const text = await fs.promises.readFile(path.join(dir, name), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const c = { name, ...(ticket ? { ticket } : {}), last, text };
      if (text.includes('"type":"cost-state"')) await count(c);
      else later.push(c);
    }
  }
  for (const c of later) await count(c);
}

/** The running chats' spend since their last cost record, as the last scan found it (BL-202). */
export async function readLiveSpend(commonDir: string): Promise<LiveSpend[]> {
  const state = await readState(commonDir);
  return Object.values(state?.files ?? {}).flatMap((f) => (f.live ? [f.live] : []));
}

async function writeState(commonDir: string, state: ScanState): Promise<void> {
  await fs.promises.mkdir(eventsDir(commonDir), { recursive: true });
  const target = path.join(eventsDir(commonDir), STATE_FILE);
  await fs.promises.writeFile(`${target}.tmp`, JSON.stringify(state));
  await fs.promises.rename(`${target}.tmp`, target);
}
