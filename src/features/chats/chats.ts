import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { noteReply, noteResults, waitsForResult, type AgentActivity } from './activity';

export type ChatSource = 'claude-code';
export type ChatState = 'working' | 'waiting-for-input' | 'done' | 'ended';
export type LinkKind = 'cwd' | 'edit' | 'manual';

/** What the hook writes to `<git dir>/flotilla/chats/<sessionId>.json`. */
export interface ChatRecord {
  sessionId: string;
  source: ChatSource;
  state: ChatState;
  message?: string;
  firstPrompt?: string;
  /** The agent name the hook gave the chat (its ticket reports are signed with it). */
  agent?: string;
  cwd?: string;
  linkedBy: LinkKind;
  /** Git dir of the worktree the chat belongs to, when that is not the one it runs in (set by linking). */
  home?: string;
  /** Git dirs the hook mirrors this record into. */
  linkedDirs: string[];
  startedAt?: Date;
  updatedAt: Date;
}

/** A chat found in Claude Code's transcripts (this environment only). */
export interface TranscriptInfo {
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  startedAt?: Date;
  updatedAt: Date;
  /** The model and effort of its last reply (the user can switch them during a chat). */
  model?: string;
  effort?: string;
  /** Its token use so far (its own replies; subagents' aren't counted). */
  usage?: ChatUsage;
  /** What started it: "claude-vscode" (Claude Code's panel), "cli" (a terminal), "sdk-cli" (`claude -p`: an agent)… */
  entrypoint?: string;
  /** What it's doing: its latest tool call, thoughts and todo list (BL-175). */
  activity?: AgentActivity;
}

/**
 * A chat's token use, from its transcript (BL-70). Every reply re-reads the whole context, so `context` (the last
 * reply's) is what each further turn costs, and `reRead` adds up to most of a long chat's cost.
 */
export interface ChatUsage {
  turns: number;
  /** The context of its last reply: input, read from the cache and written to it. */
  context: number;
  /** Read from the cache, in all. */
  reRead: number;
  /** Written to the cache, in all. */
  written: number;
  output: number;
  /** The same command failed this many times in a row, with no edit in between (an agent going round in circles). */
  failStreak: number;
  /** Runs of failures so far: a new one starts when a command fails after a success, an edit or another command. */
  failRuns: number;
}

export interface Chat {
  id: string;
  source: ChatSource;
  title: string;
  state: ChatState;
  message?: string;
  linkedBy: LinkKind;
  /** Where the chat runs, when that is not this worktree (linked by edits or by hand). */
  cwd?: string;
  updatedAt: Date;
  /** Open chats are shown above the history and counted on the rail. */
  open: boolean;
  /** The first message (its first 200 characters), when known: agents started for backlog items name the item there. */
  firstPrompt?: string;
  /** The agent name the hook gave it; a name in its first message (Flotilla's agents) comes first. */
  agent?: string;
  startedAt?: Date;
  /** The model and effort of its last reply, from its transcript. */
  model?: string;
  effort?: string;
  usage?: ChatUsage;
  activity?: AgentActivity;
  /**
   * Its record says working, but neither it nor the transcript changed for a while (MergeOptions.staleMinutes): the
   * chat ended without the hook saying so. Its last activity; it shows as stopped, not working (BL-131).
   */
  stalled?: Date;
}

const URGENCY: Record<ChatState, number> = { 'waiting-for-input': 0, working: 1, done: 2, ended: 3 };
const STATES: readonly ChatState[] = ['working', 'waiting-for-input', 'done', 'ended'];
const LINKS: readonly LinkKind[] = ['cwd', 'edit', 'manual'];

/**
 * Claude Code session ids are UUIDs. They come from files other tools can write and end up in file names, so
 * anything else (such as "../x") is ignored.
 */
export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

export function chatsDir(gitDir: string): string {
  return path.join(gitDir, 'flotilla', 'chats');
}

function unlinkedFile(gitDir: string): string {
  return path.join(gitDir, 'flotilla', 'unlinked.json');
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseChatRecord(raw: string): ChatRecord | undefined {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const updatedAt = toDate(data.updatedAt);
  const sessionId = text(data.sessionId);
  if (!isSessionId(sessionId) || !updatedAt || !STATES.includes(data.state as ChatState)) return undefined;
  return {
    sessionId,
    source: 'claude-code',
    state: data.state as ChatState,
    message: text(data.message),
    firstPrompt: text(data.firstPrompt),
    agent: text(data.agent),
    cwd: text(data.cwd),
    linkedBy: LINKS.includes(data.linkedBy as LinkKind) ? (data.linkedBy as LinkKind) : 'cwd',
    home: text(data.home),
    linkedDirs: Array.isArray(data.linkedDirs) ? data.linkedDirs.filter((d): d is string => typeof d === 'string') : [],
    startedAt: toDate(data.startedAt),
    updatedAt,
  };
}

/**
 * Marks a chat done in every record of it in the repository (the common dir's and each worktree's), when they still
 * say it works or waits: its process ended, whatever its hooks wrote last (BL-131). The git dirs it changed.
 */
export async function finishChatRecords(commonDir: string, sessionId: string, now = new Date()): Promise<string[]> {
  if (!isSessionId(sessionId)) return [];
  const worktrees = await fs.readdir(path.join(commonDir, 'worktrees')).catch(() => [] as string[]);
  const dirs = [commonDir, ...worktrees.map((w) => path.join(commonDir, 'worktrees', w))];
  const changed = await Promise.all(
    dirs.map(async (dir) => {
      const file = path.join(chatsDir(dir), `${sessionId}.json`);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      if (data.state !== 'working' && data.state !== 'waiting-for-input') return undefined;
      const { message: _message, ...rest } = data;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify({ ...rest, state: 'done', updatedAt: now.toISOString() }));
        await fs.rename(tmp, file);
        return dir;
      } catch {
        return undefined;
      }
    }),
  );
  return changed.filter((d): d is string => d !== undefined);
}

export async function readChatRecords(gitDir: string): Promise<ChatRecord[]> {
  const dir = chatsDir(gitDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        try {
          return parseChatRecord(await fs.readFile(path.join(dir, n), 'utf8'));
        } catch {
          return undefined;
        }
      }),
  );
  return records.filter((r): r is ChatRecord => r !== undefined);
}

export async function readUnlinked(gitDir: string): Promise<Set<string>> {
  try {
    const list: unknown = JSON.parse(await fs.readFile(unlinkedFile(gitDir), 'utf8'));
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function writeUnlinked(gitDir: string, ids: Set<string>): Promise<void> {
  const file = unlinkedFile(gitDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify([...ids]));
}

function recordFile(gitDir: string, sessionId: string): string {
  return path.join(chatsDir(gitDir), `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

async function readRaw(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function writeRaw(file: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

export interface LinkRequest {
  sessionId: string;
  /** Git dir of the worktree the chat runs in (its cwd). */
  ownerGitDir: string;
  /** Directory the chat runs in. */
  cwd: string;
  /** Git dir of the worktree to link it to. */
  targetGitDir: string;
  title?: string;
  state?: ChatState;
}

/**
 * Links a chat to another worktree and makes that its home: it is listed there instead of where it runs, and the
 * hook mirrors its state there from now on. Works without hooks too (the state is then not live).
 */
export async function linkChat(req: LinkRequest): Promise<void> {
  const now = new Date().toISOString();
  const ownerFile = recordFile(req.ownerGitDir, req.sessionId);
  const owner = (await readRaw(ownerFile)) ?? {
    sessionId: req.sessionId,
    source: 'claude-code',
    state: req.state ?? 'done',
    linkedBy: 'cwd',
    cwd: req.cwd,
    startedAt: now,
    updatedAt: now,
  };
  const dirs = Array.isArray(owner.linkedDirs) ? (owner.linkedDirs as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  owner.linkedDirs = dirs.some((d) => path.resolve(d) === path.resolve(req.targetGitDir)) ? dirs : [...dirs, req.targetGitDir];
  owner.home = req.targetGitDir;
  if (req.title && typeof owner.firstPrompt !== 'string') owner.firstPrompt = req.title;
  await writeRaw(ownerFile, owner);

  const ids = await readUnlinked(req.targetGitDir);
  if (ids.delete(req.sessionId)) await writeUnlinked(req.targetGitDir, ids);
  await writeRaw(recordFile(req.targetGitDir, req.sessionId), { ...owner, linkedBy: 'manual', linkedDirs: [] });
}

/**
 * Removes a chat from a worktree. A chat whose home this was goes back to the worktree it runs in
 * (ownerGitDir); transcripts and edits no longer bring it back here.
 */
export async function unlinkChat(gitDir: string, sessionId: string, ownerGitDir?: string): Promise<void> {
  const ids = await readUnlinked(gitDir);
  ids.add(sessionId);
  await writeUnlinked(gitDir, ids);
  await fs.rm(recordFile(gitDir, sessionId), { force: true });
  if (!ownerGitDir || path.resolve(ownerGitDir) === path.resolve(gitDir)) return;
  const ownerFile = recordFile(ownerGitDir, sessionId);
  const owner = await readRaw(ownerFile);
  if (!owner) return;
  if (typeof owner.home === 'string' && path.resolve(owner.home) === path.resolve(gitDir)) delete owner.home;
  if (Array.isArray(owner.linkedDirs)) owner.linkedDirs = owner.linkedDirs.filter((d) => typeof d !== 'string' || path.resolve(d) !== path.resolve(gitDir));
  await writeRaw(ownerFile, owner);
}

/**
 * Marks a chat's record done (a Check found it says working, but nothing runs it: BL-163). The record stays, and so
 * does its transcript; the hook moves it on again if the chat goes on. False if it has no record there.
 */
export async function markChatDone(gitDir: string, sessionId: string, now = new Date()): Promise<boolean> {
  const file = recordFile(gitDir, sessionId);
  const record = await readRaw(file);
  if (!record) return false;
  await writeRaw(file, { ...record, state: 'done', updatedAt: now.toISOString() });
  return true;
}

/** Ids of chats recorded here that belong to another worktree (linked away from this one). */
export function homedElsewhere(records: readonly ChatRecord[], gitDir: string): Set<string> {
  return new Set(records.filter((r) => r.home && path.resolve(r.home) !== path.resolve(gitDir)).map((r) => r.sessionId));
}

// ---- transcripts ----

export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Claude Code's project folder name for a working directory: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** What a transcript's lines say so far. Transcripts only grow, so this is kept and new lines are added to it. */
interface TranscriptScan {
  aiTitle?: string;
  customTitle?: string;
  firstPrompt?: string;
  startedAt?: Date;
  model?: string;
  effort?: string;
  usage?: ChatUsage;
  /** The reply last counted (one reply can be written over several lines). */
  lastReply?: string;
  /** The shell commands whose results come next (by tool call), and the one failing in a row (see ChatUsage.failStreak). */
  pending?: Map<string, string>;
  failing?: string;
  entrypoint?: string;
  activity?: AgentActivity;
}

/** A transcript as far as it has been read: the bytes before `offset` are in `scan`, and `head` identifies the file. */
interface TranscriptCache {
  ino: number;
  mtimeMs: number;
  size: number;
  head: Buffer;
  offset: number;
  scan: TranscriptScan;
  info: TranscriptInfo;
}

const transcriptCache = new Map<string, TranscriptCache>();
/** Bytes from the start of a file that identify it: a file whose start changed was rewritten. */
const HEAD_BYTES = 256;
/** Transcripts are read in chunks this big, and the event loop gets a turn between chunks. */
const CHUNK_BYTES = 256 * 1024;

function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return text(content);
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') return text((part as { text?: unknown }).text);
  }
  return undefined;
}

/** Adds one line of a transcript (a JSON object, or nothing) to what has been read. */
function scanLine(scan: TranscriptScan, line: string): void {
  if (!line) return;
  const isTitle = line.includes('"ai-title"') || line.includes('"custom-title"');
  const isUser = !scan.firstPrompt && line.includes('"type":"user"');
  const isReply = line.includes('"type":"assistant"');
  const isResult = (!!scan.pending?.size || waitsForResult(scan.activity)) && line.includes('"tool_result"');
  if (!isTitle && !isUser && !isReply && !isResult && scan.startedAt) return;
  let entry: {
    type?: unknown;
    timestamp?: unknown;
    cwd?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    aiTitle?: unknown;
    customTitle?: unknown;
    effort?: unknown;
    entrypoint?: unknown;
    message?: { id?: unknown; model?: unknown; content?: unknown; usage?: Record<string, unknown> };
  };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return;
  }
  scan.startedAt ??= toDate(entry.timestamp);
  scan.entrypoint ??= text(entry.entrypoint);
  if (entry.type === 'ai-title') scan.aiTitle = text(entry.aiTitle) ?? scan.aiTitle;
  else if (entry.type === 'custom-title') scan.customTitle = text(entry.customTitle) ?? scan.customTitle;
  else if (entry.type === 'user' && !entry.isSidechain) {
    if (!scan.firstPrompt && !entry.isMeta) scan.firstPrompt = promptText(entry.message?.content)?.slice(0, 200);
    if (scan.pending?.size) watchResult(scan, entry.message?.content);
    scan.activity = noteResults(scan.activity, entry.message?.content);
  } else if (entry.type === 'assistant' && !entry.isSidechain) {
    // The model and effort are the last reply's (not a subagent's). An effort belongs to the reply it came with.
    if (typeof entry.message?.model === 'string' && entry.message.model !== '<synthetic>') {
      scan.model = entry.message.model;
      scan.effort = undefined;
    }
    if (typeof entry.effort === 'string') scan.effort = entry.effort;
    countUsage(scan, entry.message);
    watchTools(scan, entry.message?.content);
    scan.activity = noteReply(scan.activity, entry.message?.content, entry.timestamp, entry.cwd);
  }
}

const EMPTY_USAGE: ChatUsage = { turns: 0, context: 0, reRead: 0, written: 0, output: 0, failStreak: 0, failRuns: 0 };
/** The tools agents run commands with: Bash, and PowerShell on Windows. */
const SHELLS = new Set(['Bash', 'PowerShell']);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Adds a reply's tokens (once per reply: its lines carry the same usage). */
function countUsage(scan: TranscriptScan, message: { id?: unknown; usage?: Record<string, unknown> } | undefined): void {
  const u = message?.usage;
  if (!u) return;
  const id = typeof message.id === 'string' ? message.id : undefined;
  if (id && id === scan.lastReply) return;
  scan.lastReply = id;
  const before = scan.usage ?? EMPTY_USAGE;
  const read = num(u.cache_read_input_tokens);
  const written = num(u.cache_creation_input_tokens);
  scan.usage = {
    ...before,
    turns: before.turns + 1,
    context: num(u.input_tokens) + read + written,
    reRead: before.reRead + read,
    written: before.written + written,
    output: before.output + num(u.output_tokens),
  };
}

/** Notes shell calls (their results come next), and an edit (which ends a run of failures: the agent changed something). */
function watchTools(scan: TranscriptScan, content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const part of content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: { command?: unknown } }>) {
    if (part?.type !== 'tool_use') continue;
    if (typeof part.name === 'string' && SHELLS.has(part.name) && typeof part.id === 'string' && typeof part.input?.command === 'string') {
      (scan.pending ??= new Map()).set(part.id, part.input.command.trim());
    } else if (part.name === 'Edit' || part.name === 'Write' || part.name === 'MultiEdit' || part.name === 'NotebookEdit') {
      scan.failing = undefined;
      if (scan.usage) scan.usage = { ...scan.usage, failStreak: 0 };
    }
  }
}

/** Counts a failed result of the same command again: its success ends the run, another command failing starts a new one. */
function watchResult(scan: TranscriptScan, content: unknown): void {
  if (!Array.isArray(content) || !scan.pending) return;
  for (const result of content as Array<{ type?: unknown; tool_use_id?: unknown; is_error?: unknown }>) {
    if (result?.type !== 'tool_result' || typeof result.tool_use_id !== 'string') continue;
    const command = scan.pending.get(result.tool_use_id);
    if (command === undefined) continue;
    scan.pending.delete(result.tool_use_id);
    const usage = scan.usage ?? EMPTY_USAGE;
    if (result.is_error !== true) {
      if (scan.failing === command) scan.failing = undefined;
      scan.usage = { ...usage, failStreak: scan.failing ? usage.failStreak : 0 };
    } else if (scan.failing === command && usage.failStreak > 0) {
      scan.usage = { ...usage, failStreak: usage.failStreak + 1 };
    } else {
      scan.usage = { ...usage, failStreak: 1, failRuns: usage.failRuns + 1 };
      scan.failing = command;
    }
  }
}

/** What it's doing, with the command failing in a row (the usage counts it). */
function activityOf(scan: TranscriptScan): AgentActivity | undefined {
  const times = scan.usage?.failStreak ?? 0;
  if (!scan.activity) return undefined;
  return times > 0 && scan.failing ? { ...scan.activity, failing: { command: scan.failing, times } } : scan.activity;
}

function infoOf(sessionId: string, scan: TranscriptScan, updatedAt: Date): TranscriptInfo {
  // A title the user set wins; Flotilla's own "<worktree>: <AI title>" tag is shown without the worktree.
  const custom = scan.customTitle;
  const title = custom && !(scan.aiTitle && custom.endsWith(`: ${scan.aiTitle}`)) ? custom : scan.aiTitle;
  return {
    sessionId,
    updatedAt,
    ...optional('title', title),
    ...optional('firstPrompt', scan.firstPrompt),
    ...optional('startedAt', scan.startedAt),
    ...optional('model', scan.model),
    ...optional('effort', scan.effort),
    ...optional('usage', scan.usage),
    ...optional('entrypoint', scan.entrypoint),
    ...optional('activity', activityOf(scan)),
  };
}

/** Reads a transcript's title (the latest `ai-title`), first prompt, start time, and model and effort. */
export function parseTranscript(sessionId: string, raw: string, updatedAt: Date): TranscriptInfo {
  const scan: TranscriptScan = {};
  for (const line of raw.split('\n')) scanLine(scan, line);
  return infoOf(sessionId, scan, updatedAt);
}

/**
 * Feeds the complete lines of a file from `from` up to `to` into `onLine`, in chunks. A last line without its newline
 * waits for the next read. Returns the offset after the last line fed.
 */
async function readLines(handle: fs.FileHandle, from: number, to: number, onLine: (line: string) => void): Promise<number> {
  const buf = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, to - from)));
  let consumed = from;
  let pending: Buffer[] = [];
  for (let pos = from; pos < to; ) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, to - pos), pos);
    if (bytesRead === 0) break;
    const data = buf.subarray(0, bytesRead);
    let start = 0;
    for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, start)) {
      const tail = data.subarray(start, nl);
      onLine((pending.length ? Buffer.concat([...pending, tail]) : tail).toString('utf8'));
      pending = [];
      start = nl + 1;
      consumed = pos + start;
    }
    if (start < bytesRead) pending.push(Buffer.from(data.subarray(start)));
    pos += bytesRead;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return consumed;
}

async function readTranscriptFile(file: string, sessionId: string): Promise<TranscriptInfo | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.stat(file);
    const cached = transcriptCache.get(file);
    if (cached && cached.ino === stat.ino && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;
    handle = await fs.open(file, 'r');
    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    await handle.read(head, 0, head.length, 0);
    // Only lines after the last read are read again, if the file is the same one and only grew. Otherwise, from the start.
    const grew =
      cached !== undefined &&
      cached.ino === stat.ino &&
      stat.size >= cached.offset &&
      head.length >= cached.head.length &&
      head.subarray(0, cached.head.length).equals(cached.head);
    const scan: TranscriptScan = grew ? { ...cached.scan } : {};
    const offset = await readLines(handle, grew ? cached.offset : 0, stat.size, (line) => scanLine(scan, line));
    const info = infoOf(sessionId, scan, stat.mtime);
    // Offset, scan and info are stored together, so a read that overlapped another one never leaves them inconsistent.
    transcriptCache.set(file, { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, head, offset, scan, info });
    return info;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function transcriptPath(cwd: string, sessionId: string, home = claudeHome()): string {
  if (!isSessionId(sessionId)) throw new Error(`Not a valid chat session id: ${sessionId}`);
  return path.join(home, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** One chat's transcript, for chats that run in another directory than the worktree they are linked to. */
export function readTranscript(cwd: string, sessionId: string, home = claudeHome()): Promise<TranscriptInfo | undefined> {
  return readTranscriptFile(transcriptPath(cwd, sessionId, home), sessionId);
}

export async function readTranscripts(worktreeDir: string, home = claudeHome()): Promise<TranscriptInfo[]> {
  const dir = path.join(home, 'projects', encodeProjectDir(worktreeDir));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: TranscriptInfo[] = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl') && isSessionId(n.slice(0, -'.jsonl'.length)))) {
    const info = await readTranscriptFile(path.join(dir, name), name.slice(0, -'.jsonl'.length));
    if (info) out.push(info);
  }
  return out;
}

// ---- merging ----

export interface MergeOptions {
  now: Date;
  /** A chat that reported nothing for this long is no longer open. */
  openHours: number;
  /** A 'working' report older than this, with no newer transcript, is shown as done (and stalled). */
  staleMinutes: number;
}

export function mergeChats(records: ChatRecord[], transcripts: TranscriptInfo[], unlinked: ReadonlySet<string>, opts: MergeOptions): Chat[] {
  const byId = new Map<string, Chat>();
  const transcriptById = new Map(transcripts.map((t) => [t.sessionId, t]));
  for (const r of records) {
    if (unlinked.has(r.sessionId)) continue;
    const t = transcriptById.get(r.sessionId);
    const age = opts.now.getTime() - r.updatedAt.getTime();
    const updatedAt = t && t.updatedAt > r.updatedAt ? t.updatedAt : r.updatedAt;
    // A chat that writes its transcript is alive, even when its last hook was long ago (a long command).
    const stalled = r.state === 'working' && opts.now.getTime() - updatedAt.getTime() > opts.staleMinutes * 60_000;
    const state: ChatState = stalled ? 'done' : r.state;
    byId.set(r.sessionId, {
      id: r.sessionId,
      source: r.source,
      title: t?.title ?? r.firstPrompt ?? t?.firstPrompt ?? 'Untitled chat',
      state,
      message: state === 'waiting-for-input' ? r.message : undefined,
      linkedBy: r.linkedBy,
      cwd: r.linkedBy === 'cwd' ? undefined : r.cwd,
      updatedAt,
      open: state !== 'ended' && age <= opts.openHours * 3_600_000,
      ...optional('firstPrompt', r.firstPrompt ?? t?.firstPrompt),
      // The chat Flotilla named ("Orbit-2 · review BL-132") is that agent's, whatever name the hook gave it first.
      ...optional('agent', titleAgent(t?.title) ?? r.agent),
      ...(stalled ? { stalled: updatedAt } : {}),
      ...optional('startedAt', r.startedAt ?? t?.startedAt),
      ...optional('model', t?.model),
      ...optional('effort', t?.effort),
      ...optional('usage', t?.usage),
      ...optional('activity', t?.activity),
    });
  }
  for (const t of transcripts) {
    if (byId.has(t.sessionId) || unlinked.has(t.sessionId)) continue;
    byId.set(t.sessionId, {
      id: t.sessionId,
      source: 'claude-code',
      title: t.title ?? t.firstPrompt ?? 'Untitled chat',
      state: 'ended',
      linkedBy: 'cwd',
      updatedAt: t.updatedAt,
      open: false,
      ...optional('firstPrompt', t.firstPrompt),
      ...optional('startedAt', t.startedAt),
      ...optional('model', t.model),
      ...optional('effort', t.effort),
      ...optional('usage', t.usage),
    });
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.open) - Number(a.open) || (a.open ? URGENCY[a.state] - URGENCY[b.state] : 0) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
}

/** The agent a chat's title names: Flotilla names its agents' chats "<agent> · <what>" ("Orbit-2 · review BL-132"). */
export function titleAgent(title: string | undefined): string | undefined {
  return /^([A-Za-z]+-\d+) · /.exec(title ?? '')?.[1];
}

/** { [key]: value } when there's a value; nothing otherwise (keeps chats free of undefined fields). */
function optional<K extends string, V>(key: K, value: V | undefined): { [k in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [k in K]?: V };
}

/** The most urgent open chat, which stands for the worktree's agent state. */
export function mostUrgent(chats: readonly Chat[]): Chat | undefined {
  return chats.filter((c) => c.open).sort((a, b) => URGENCY[a.state] - URGENCY[b.state] || b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}

// ---- titles in Claude Code's own session list ----

export type TagResult = 'tagged' | 'hasCustomTitle' | 'noTitleYet' | 'missing';

/**
 * Shows the worktree in Claude Code's session list: once the chat has an AI title, appends a `custom-title` record
 * ("<label>: <AI title>"), the same record Claude Code's own Rename writes. A title the user set is never replaced.
 */
export async function tagTranscriptTitle(file: string, sessionId: string, label: string): Promise<TagResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return 'missing';
  }
  if (raw.includes('"custom-title"')) return 'hasCustomTitle';
  const title = parseTranscript(sessionId, raw, new Date()).title;
  if (!title) return 'noTitleYet';
  const record = JSON.stringify({ type: 'custom-title', sessionId, customTitle: `${label}: ${title}` });
  await fs.appendFile(file, `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${record}\n`);
  return 'tagged';
}

/**
 * What an open chat waits for from the user, if anything: an approval (a permission prompt: a command, an edit), or a
 * reply (it finished its turn, and its output waits for the user). A chat that hasn't had a prompt yet waits for
 * nothing.
 */
export function awaiting(chat: Pick<Chat, 'state' | 'message' | 'open' | 'firstPrompt'>): 'approval' | 'reply' | undefined {
  if (!chat.open) return undefined;
  if (chat.state === 'waiting-for-input') return /permission|approv|allow/i.test(chat.message ?? '') ? 'approval' : 'reply';
  if (chat.state === 'done' && chat.firstPrompt) return 'reply';
  return undefined;
}

/**
 * Whether a chat ran without Claude Code's panel or terminal (`claude -p`, the SDKs): Flotilla's agents. Claude Code's
 * panel leaves such sessions out of what it lists and loads, so opening one there gives an empty chat.
 */
export function isHeadless(t: Pick<TranscriptInfo, 'entrypoint'> | undefined): boolean {
  return !!t?.entrypoint?.startsWith('sdk-');
}

/** Whether a copied transcript only holds what its original does: nobody continued the copy (titles and such aside). */
export function copyIsUnchanged(copy: string, original: string): boolean {
  const lines = new Set(original.split('\n'));
  return copy.split('\n').every((line) => !line || lines.has(line) || !(line.includes('"type":"user"') || line.includes('"type":"assistant"')));
}

/**
 * Undoes what opening a chat from another worktree did before BL-121: it copied the transcript into this folder's
 * Claude Code project, and recorded the chat in its worktree as linked by hand, running here. Where the original is
 * still in its worktree's project and the copy wasn't continued, the copy goes and the worktree's record points back
 * at the original. Returns the chats put back.
 */
export async function removeChatCopies(o: { root: string; gitDir: string; worktrees: readonly { root: string; gitDir: string }[]; home?: string }): Promise<string[]> {
  const home = o.home ?? claudeHome();
  const restored: string[] = [];
  for (const w of o.worktrees) {
    if (path.resolve(w.gitDir) === path.resolve(o.gitDir)) continue;
    for (const r of await readChatRecords(w.gitDir)) {
      if (r.linkedBy !== 'manual' || !r.cwd || path.resolve(r.cwd) !== path.resolve(o.root)) continue;
      const copy = transcriptPath(o.root, r.sessionId, home);
      let original: string;
      let copied: string;
      try {
        original = await fs.readFile(transcriptPath(w.root, r.sessionId, home), 'utf8');
        copied = await fs.readFile(copy, 'utf8');
      } catch {
        continue; // started here for that worktree (there's no original), or already put back
      }
      if (!copyIsUnchanged(copied, original)) continue;
      await fs.rm(copy, { force: true });
      await fs.rm(copy.slice(0, -'.jsonl'.length), { recursive: true, force: true });
      const file = recordFile(w.gitDir, r.sessionId);
      const record = await readRaw(file);
      if (record) {
        // The title it was linked with stood in for its first prompt; the original's transcript has the real one.
        const { home: _home, linkedDirs: _dirs, firstPrompt: _prompt, ...rest } = record;
        await writeRaw(file, { ...rest, linkedBy: 'cwd', cwd: w.root });
      }
      const here = recordFile(o.gitDir, r.sessionId);
      const owner = await readRaw(here);
      if (owner && typeof owner.home === 'string' && path.resolve(owner.home) === path.resolve(w.gitDir)) await fs.rm(here, { force: true });
      restored.push(r.sessionId);
    }
  }
  return restored;
}
