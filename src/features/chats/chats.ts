import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
}

const URGENCY: Record<ChatState, number> = { 'waiting-for-input': 0, working: 1, done: 2, ended: 3 };
const STATES: readonly ChatState[] = ['working', 'waiting-for-input', 'done', 'ended'];
const LINKS: readonly LinkKind[] = ['cwd', 'edit', 'manual'];

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
  if (!sessionId || !updatedAt || !STATES.includes(data.state as ChatState)) return undefined;
  return {
    sessionId,
    source: 'claude-code',
    state: data.state as ChatState,
    message: text(data.message),
    firstPrompt: text(data.firstPrompt),
    cwd: text(data.cwd),
    linkedBy: LINKS.includes(data.linkedBy as LinkKind) ? (data.linkedBy as LinkKind) : 'cwd',
    home: text(data.home),
    linkedDirs: Array.isArray(data.linkedDirs) ? data.linkedDirs.filter((d): d is string => typeof d === 'string') : [],
    startedAt: toDate(data.startedAt),
    updatedAt,
  };
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

const transcriptCache = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>();

function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return text(content);
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') return text((part as { text?: unknown }).text);
  }
  return undefined;
}

/** Reads a transcript's title (the latest `ai-title`), first prompt and start time. */
export function parseTranscript(sessionId: string, raw: string, updatedAt: Date): TranscriptInfo {
  const info: TranscriptInfo = { sessionId, updatedAt };
  let custom: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const isTitle = line.includes('"ai-title"') || line.includes('"custom-title"');
    const isUser = !info.firstPrompt && line.includes('"type":"user"');
    if (!isTitle && !isUser && info.startedAt) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    info.startedAt ??= toDate(entry.timestamp);
    if (entry.type === 'ai-title') info.title = text(entry.aiTitle) ?? info.title;
    else if (entry.type === 'custom-title') custom = text(entry.customTitle) ?? custom;
    else if (entry.type === 'user' && !info.firstPrompt && !entry.isSidechain && !entry.isMeta) {
      info.firstPrompt = promptText((entry.message as { content?: unknown } | undefined)?.content)?.slice(0, 200);
    }
  }
  // A title the user set wins; Flotilla's own "<worktree>: <AI title>" tag is shown without the worktree.
  if (custom && !(info.title && custom.endsWith(`: ${info.title}`))) info.title = custom;
  return info;
}

async function readTranscriptFile(file: string, sessionId: string): Promise<TranscriptInfo | undefined> {
  try {
    const stat = await fs.stat(file);
    const cached = transcriptCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.info;
    const info = parseTranscript(sessionId, await fs.readFile(file, 'utf8'), stat.mtime);
    transcriptCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    return info;
  } catch {
    return undefined;
  }
}

export function transcriptPath(cwd: string, sessionId: string, home = claudeHome()): string {
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
  for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
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
  /** A 'working' report older than this is shown as done. */
  staleMinutes: number;
}

export function mergeChats(records: ChatRecord[], transcripts: TranscriptInfo[], unlinked: ReadonlySet<string>, opts: MergeOptions): Chat[] {
  const byId = new Map<string, Chat>();
  const transcriptById = new Map(transcripts.map((t) => [t.sessionId, t]));
  for (const r of records) {
    if (unlinked.has(r.sessionId)) continue;
    const t = transcriptById.get(r.sessionId);
    const age = opts.now.getTime() - r.updatedAt.getTime();
    const state: ChatState = r.state === 'working' && age > opts.staleMinutes * 60_000 ? 'done' : r.state;
    byId.set(r.sessionId, {
      id: r.sessionId,
      source: r.source,
      title: t?.title ?? r.firstPrompt ?? t?.firstPrompt ?? 'Untitled chat',
      state,
      message: state === 'waiting-for-input' ? r.message : undefined,
      linkedBy: r.linkedBy,
      cwd: r.linkedBy === 'cwd' ? undefined : r.cwd,
      updatedAt: t && t.updatedAt > r.updatedAt ? t.updatedAt : r.updatedAt,
      open: state !== 'ended' && age <= opts.openHours * 3_600_000,
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
    });
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.open) - Number(a.open) || (a.open ? URGENCY[a.state] - URGENCY[b.state] : 0) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
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

export type ImportResult = 'copied' | 'exists' | 'missing';

/**
 * Copies a chat's transcript (and its folder of attachments, if any) from the Claude Code project of one directory to
 * another's, so Claude Code's panel in a window on `toCwd` can open it. An existing copy is never overwritten.
 */
export async function importTranscript(fromCwd: string, toCwd: string, sessionId: string, home = claudeHome()): Promise<ImportResult> {
  const from = transcriptPath(fromCwd, sessionId, home);
  const to = transcriptPath(toCwd, sessionId, home);
  try {
    await fs.access(to);
    return 'exists';
  } catch {
    // not there yet
  }
  try {
    await fs.access(from);
  } catch {
    return 'missing';
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  const extras = from.slice(0, -'.jsonl'.length);
  try {
    if ((await fs.stat(extras)).isDirectory()) await fs.cp(extras, to.slice(0, -'.jsonl'.length), { recursive: true, errorOnExist: false, force: false });
  } catch {
    // no attachments folder
  }
  return 'copied';
}
