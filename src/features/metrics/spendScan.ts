import * as fs from 'node:fs';
import * as path from 'node:path';
import { encodeProjectDir } from '../chats/chats';
import { mergeRoot } from '../backlog/merge';
import { appendEvents, eventsDir, type FlotillaEvent } from './events';
import { transcriptSpend } from './transcriptSpend';

/** What the scans counted so far, by transcript (its folder and file): its size and time then, and its last entry counted. */
const STATE_FILE = 'spend-scan.json';
/** A chat that hasn't changed for this long is over (or idle): what's after its last cost record is counted at the price table's. */
export const IDLE_MS = 30 * 60_000;

interface FileState {
  size: number;
  mtimeMs: number;
  last?: string;
  open?: true;
}

interface ScanState {
  files: Record<string, FileState>;
}

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
    const rest = name === root ? '' : name.startsWith(worktrees) ? name.slice(worktrees.length) : name.startsWith(merges) ? name.slice(merges.length) : undefined;
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
  const state: ScanState = { files: { ...was?.files } };
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
      data: { session, purpose: p.purpose, to: p.to, tokens: p.tokens, costUsd: Math.round(p.costUsd * 1e6) / 1e6, contextK: p.contextK, tools: p.tools, ...(p.priced ? { priced: true as const } : {}) },
      ...(was ? {} : { imported: true as const }),
    }));
    await appendEvents(o.commonDir, events);
    recorded += events.length;
    const last = spend.last ?? before?.last;
    state.files[c.key] = { size: c.stat.size, mtimeMs: c.stat.mtimeMs, ...(last ? { last } : {}), ...(spend.open ? { open: true as const } : {}) };
    // Noted at once: a scan cut short doesn't record these parts again.
    if (events.length) await writeState(o.commonDir, state);
    // Out of the way of the window: a file at a time.
    await new Promise((resolve) => setImmediate(resolve));
  };
  const later: Array<{ key: string; file: string; name: string; ticket?: string; stat: fs.Stats }> = [];
  for (const { dir, ticket } of await projectDirs(o.home, o.mainRoot, o.tmp)) {
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

async function writeState(commonDir: string, state: ScanState): Promise<void> {
  await fs.promises.mkdir(eventsDir(commonDir), { recursive: true });
  const target = path.join(eventsDir(commonDir), STATE_FILE);
  await fs.promises.writeFile(`${target}.tmp`, JSON.stringify(state));
  await fs.promises.rename(`${target}.tmp`, target);
}
