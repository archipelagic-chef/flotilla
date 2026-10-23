import * as fs from 'node:fs';
import * as path from 'node:path';

/** Pause All's record (BL-160), in the repository's .git/flotilla/: every window sees it, and it survives a restart. */
export const PAUSED_ALL_FILE = 'paused-all.json';

/** An agent Pause All paused: a ticket's agent (its chat), or its discussion (BL-45). */
export interface PausedAgent {
  id: string;
  kind: 'agent' | 'discussion';
  /** The chat it goes on in: Resume All resumes it only while the ticket is still paused in that chat. */
  session?: string;
}

/** While it's there, no agent starts on its own (the queue and the autopilot hold); Resume All resumes `agents`. */
export interface PausedAll {
  /** ISO 8601. */
  at: string;
  agents: PausedAgent[];
}

/** Pause All's record, read again when the file changes (another window paused or resumed). */
export class PausedAllStore {
  private cached: { mtime: number; value: PausedAll | undefined } | undefined;

  constructor(private readonly commonDir: string) {}

  get file(): string {
    return path.join(this.commonDir, 'flotilla', PAUSED_ALL_FILE);
  }

  /** The record, if all agents are paused; synchronous (the queue asks it before each start), cached by mtime. */
  read(): PausedAll | undefined {
    let mtime: number;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.cached = undefined;
      return undefined;
    }
    if (this.cached?.mtime === mtime) return this.cached.value;
    let value: PausedAll | undefined;
    try {
      value = parsePausedAll(fs.readFileSync(this.file, 'utf8'));
    } catch {
      value = undefined;
    }
    this.cached = { mtime, value };
    return value;
  }

  get held(): boolean {
    return this.read() !== undefined;
  }

  async write(value: PausedAll): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(this.file, `${JSON.stringify(value, null, 1)}\n`);
    this.cached = undefined;
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.file, { force: true });
    this.cached = undefined;
  }
}

/** The record from its file's text; a file that isn't one still holds (an empty set), so nothing starts by mistake. */
export function parsePausedAll(text: string): PausedAll {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { at: '', agents: [] };
  }
  const r = (raw ?? {}) as { at?: unknown; agents?: unknown };
  const agents = Array.isArray(r.agents)
    ? r.agents.flatMap((a: { id?: unknown; kind?: unknown; session?: unknown }): PausedAgent[] =>
        typeof a?.id === 'string' && (a.kind === 'agent' || a.kind === 'discussion')
          ? [{ id: a.id, kind: a.kind, ...(typeof a.session === 'string' ? { session: a.session } : {}) }]
          : [],
      )
    : [];
  return { at: typeof r.at === 'string' ? r.at : '', agents };
}

/** Adds what a later Pause All paused to the set (an agent once: the later entry replaces the earlier one). */
export function mergePaused(before: PausedAgent[], added: PausedAgent[]): PausedAgent[] {
  const ids = new Set(added.map((a) => `${a.kind}:${a.id}`));
  return [...before.filter((a) => !ids.has(`${a.kind}:${a.id}`)), ...added];
}

/** The set in the backlog's order (its priority): the top ones get the free slots first. Gone tickets come last. */
export function resumeOrder(items: ReadonlyArray<{ id: string }>, agents: PausedAgent[]): PausedAgent[] {
  const rank = new Map(items.map((i, n) => [i.id, n]));
  const at = (a: PausedAgent) => rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  return [...agents].sort((a, b) => at(a) - at(b));
}

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/** What Pause All says it did: "Paused 5 agents. 2 agents in chats can't be paused: …". */
export function pausedMessage(paused: number, inChats: number): string {
  const what = paused ? `Paused ${agents(paused)}.` : 'No agent was working to pause.';
  const chats = inChats ? ` ${agents(inChats)} in chats can't be paused: stop ${inChats === 1 ? 'it' : 'them'} there.` : '';
  return `${what}${chats} Nothing new starts until Resume All.`;
}

/** What Resume All says it did: "Resumed 4; 1 waits for a slot." */
export function resumedMessage(resumed: number, waiting: number): string {
  if (!resumed && !waiting) return 'Resumed: no agent was left to resume. Agents start again.';
  return `Resumed ${resumed}${waiting ? `; ${waiting} wait${waiting === 1 ? 's' : ''} for a slot` : ''}.`;
}
