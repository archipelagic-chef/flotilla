import type { Tokens } from './events';

/**
 * Where an agent's spend went (BL-189): what each part of a chat was for, told by the prompt that started it. A chat
 * that no Flotilla prompt started (the user's own) is orchestration.
 */
export type SpendPurpose = 'first' | 'review' | 'rework' | 'main' | 'resume' | 'answer' | 'shaping' | 'orchestration';
export const SPEND_PURPOSES: readonly SpendPurpose[] = ['first', 'review', 'rework', 'main', 'resume', 'answer', 'shaping', 'orchestration'];
export const PURPOSE_LABEL: Record<SpendPurpose, string> = {
  first: 'First pass',
  review: 'Review',
  rework: 'Rework after a review',
  main: 'Main and conflicts',
  resume: 'Resuming after a limit or a stop',
  answer: 'Answering the user',
  shaping: 'Shaping a ticket',
  orchestration: 'Chats not tied to a ticket',
};

/** What a tool's output was: reading code, git, tests and builds, demos, or anything else. */
export type ToolKind = 'code' | 'git' | 'tests' | 'demos' | 'other';
export const TOOL_KINDS: readonly ToolKind[] = ['code', 'git', 'tests', 'demos', 'other'];
export const TOOL_LABEL: Record<ToolKind, string> = { code: 'Reading code', git: 'Git', tests: 'Tests and builds', demos: 'Demos', other: 'Other' };

/** Flotilla's prompts, by what they start: the first that matches the prompt's beginning. */
const PROMPTS: ReadonlyArray<[SpendPurpose, RegExp]> = [
  ['review', /You are its reviewer\.|made changes after your last review|Go on with your review/],
  ['shaping', /discussing it with its owner|wants to shape it with you first|^Its owner (opened the discussion|wrote in the ticket since your last reply)/],
  ['rework', /requested changes \(review round \d+\)|^The user reviewed your work on \S+ and requested changes/],
  ['answer', /^The user answered you in the ticket/],
  [
    'main',
    /moved on, and merging it into your branch|^Your task: (fix the checks on the merge|resolve the conflicts of merging|finish merging|merge \S+ branch .* again into|with the user, rewrite the commit history)/,
  ],
  ['resume', /usage limit stopped you|^Flotilla paused you|^The user paused you|^The user stopped .+ you take over|^Flotilla stopped you:/],
  ['orchestration', /writing Flotilla's improvement review/],
  ['first', /You are agent [^,\n]+, working on backlog item/],
];

/** What a prompt is for, and the ticket and agent it names; undefined for one that isn't Flotilla's. */
export function promptPurpose(text: string): { purpose: SpendPurpose; ticket?: string; agent?: string } | undefined {
  const head = text.slice(0, 800);
  const found = PROMPTS.find(([, re]) => re.test(head));
  if (!found) return undefined;
  const ticket =
    /backlog item ([A-Z][A-Z0-9]*-\d+)\b/.exec(head)?.[1] ??
    /\b([A-Z][A-Z0-9]*-\d+)'s branch\b/.exec(head)?.[1] ??
    / (?:on|reviewing) ([A-Z][A-Z0-9]*-\d+)\b/.exec(head)?.[1];
  const agent = /You are agent ([^,\n]+),/.exec(head)?.[1];
  return { purpose: found[0], ...(ticket ? { ticket } : {}), ...(agent ? { agent } : {}) };
}

/** What a tool's output is, by the tool and (for a shell) its command. */
export function toolKind(name: string, input: unknown): ToolKind {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return 'code';
  if (name !== 'Bash') return 'other';
  const given = typeof (input as { command?: unknown })?.command === 'string' ? (input as { command: string }).command : '';
  // What it runs, after moving to a folder.
  const command = given.replace(/^(\s*cd\s+\S+\s*(&&|;)\s*)+/, '');
  if (/\bdemo\b/.test(command)) return 'demos';
  if (/\b(vitest|jest|tsc|eslint)\b|\bnpm (run )?(test|build|check|lint|compile|typecheck)\b/.test(command)) return 'tests';
  if (/\bgit\b/.test(command)) return 'git';
  if (/^\s*(cat|sed|head|tail|grep|rg|find|ls|wc)\b/.test(command)) return 'code';
  return 'other';
}

/** Prices per million tokens: input, output, cache read, 5-minute and 1-hour cache writes. */
interface Price {
  input: number;
  output: number;
  read: number;
  write5m: number;
  write1h: number;
}
/** By model family (fitted to the transcripts' cost records, for Opus and Haiku 5.5; the published rates for the others). */
const PRICES: ReadonlyArray<[RegExp, Price]> = [
  [/opus-5/, { input: 4, output: 20, read: 0.2, write5m: 5, write1h: 8 }],
  [/opus/, { input: 5, output: 25, read: 0.5, write5m: 6.25, write1h: 10 }],
  [/haiku-5/, { input: 0.8, output: 4, read: 0.08, write5m: 1, write1h: 1.6 }],
  [/haiku/, { input: 1, output: 5, read: 0.1, write5m: 1.25, write1h: 2 }],
  [/./, { input: 3, output: 15, read: 0.3, write5m: 3.75, write1h: 6 }],
];

interface Usage {
  tokens: Tokens;
  write1h: number;
}

/** A message's price from the table, in dollars. */
export function priceOf(model: string, u: Usage): number {
  const p = PRICES.find(([re]) => re.test(model))![1];
  const write5m = Math.max(0, u.tokens.cacheCreation - u.write1h);
  return (u.tokens.input * p.input + u.tokens.output * p.output + u.tokens.cacheRead * p.read + write5m * p.write5m + u.write1h * p.write1h) / 1e6;
}

/** What a chat spent in an hour (BL-202): its turns there, each counted in the local hour of its timestamp. */
export interface SpendHour {
  /** The hour's start, in local time (as an ISO time). */
  at: string;
  tokens: Tokens;
  costUsd: number;
  turns: number;
}

/** The start of the local hour a time is in, as an ISO time. */
export function hourOf(at: string | number): string {
  const d = new Date(at);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/** One part of a chat: its purpose, and what it spent from `at` to `to`. */
export interface SpendPart {
  purpose: SpendPurpose;
  at: string;
  to: string;
  tokens: Tokens;
  costUsd: number;
  /** Each turn's context (input, cache read and written), in thousands of tokens. */
  contextK: number[];
  /** Tool output, in characters, by kind. */
  tools: Partial<Record<ToolKind, number>>;
  /** What it spent hour by hour. */
  hours: SpendHour[];
  /** Some of its cost is from the price table: the chat has no cost record for it (yet). */
  priced?: true;
}

export interface TranscriptSpend {
  session?: string;
  ticket?: string;
  agent?: string;
  /** The chat's title (the user's, or Claude's), and the folder it ran in. */
  title?: string;
  cwd?: string;
  parts: SpendPart[];
  /** The time of the last entry counted: the next read counts what's after it. */
  last?: string;
  /** Entries after `last` wait for a cost record (or for the chat to be settled). */
  open?: true;
  /** Those entries' parts, priced from the table: what a running chat spent since its last cost record. */
  live?: SpendPart[];
}

type Entry = {
  type?: string;
  cwd?: string;
  aiTitle?: string;
  customTitle?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  sessionId?: string;
  totalCostUSD?: number;
  message?: { id?: string; model?: string; usage?: Record<string, unknown>; content?: unknown };
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A user entry's prompt: its text when someone (or Flotilla) wrote it, not a tool's result or a command's output. */
function promptText(e: Entry): string | undefined {
  if (e.isMeta || e.isCompactSummary || e.isSidechain) return undefined;
  const c = e.message?.content;
  const text =
    typeof c === 'string'
      ? c
      : Array.isArray(c) && !c.some((x) => x?.type === 'tool_result')
        ? c
            .filter((x) => x?.type === 'text')
            .map((x) => String(x.text ?? ''))
            .join('\n')
        : undefined;
  if (!text?.trim() || /^\s*(<|\[Request interrupted)/.test(text)) return undefined;
  return text;
}

function resultSize(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((n: number, x) => n + (typeof x?.text === 'string' ? x.text.length : 0), 0);
  return 0;
}

/**
 * A transcript's spend, split into parts by the prompts that started them: what's after `after` (the time of the last
 * entry counted before). Its cost is the chat's cost records (each the session's total so far), the difference between
 * one and the next shared among the messages between them by their price; messages after the last record are counted
 * only when `settled` (the chat ended without one, or is idle), at the price table's price. `ticket`: the ticket of the
 * chat's folder, for a chat whose prompts don't name one. `seen`: the messages counted in other chats' transcripts (a
 * resumed chat's copies of them aren't counted again); this one's are added to it. `until`: what's after it isn't counted
 * (for reading in the hours of what was counted before they were kept).
 */
export function transcriptSpend(
  text: string,
  o: { after?: string; until?: string; settled?: boolean; ticket?: string; seen?: Set<string> } = {},
): TranscriptSpend {
  // A chat resumed into a new session starts with a copy of the old one's messages, dated before it started: they were
  // the old session's spend, and counted there.
  const started = Number(/"type":"cost-state"[^\n]*?"startTime":(\d+)/.exec(text)?.[1] ?? NaN);
  const after = Math.max(o.after ? Date.parse(o.after) : -Infinity, Number.isFinite(started) ? started - 1000 : -Infinity);
  const until = o.until ? Date.parse(o.until) : Infinity;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  const out: TranscriptSpend = { parts: [], ...(o.ticket ? { ticket: o.ticket } : {}) };
  let purpose: SpendPurpose | undefined;
  let agentChat = false;
  const tools = new Map<string, ToolKind>();
  const seen = new Set<string>();
  // The messages since the last cost record, waiting for their share of the next.
  let open: Array<{ part: SpendPart | undefined; hour?: SpendHour; weight: number }> = [];
  let total = 0;
  let pending: SpendPart[] = [];
  let current: SpendPart | undefined;
  let lastOpen: string | undefined;
  // What waits for a cost record, at the price table's price.
  const priceOpen = () => {
    for (const m of open)
      if (m.part) {
        m.part.costUsd += m.weight;
        m.part.priced = true;
        if (m.hour) m.hour.costUsd += m.weight;
      }
  };
  const settle = (cost: number | undefined) => {
    if (cost !== undefined) {
      const weights = open.reduce((n, m) => n + m.weight, 0);
      open.forEach((m, i) => {
        const share = weights ? (cost * m.weight) / weights : i === open.length - 1 ? cost : 0;
        if (m.part) m.part.costUsd += share;
        if (m.hour) m.hour.costUsd += share;
      });
    } else priceOpen();
    open = [];
    out.parts.push(...pending);
    pending = [];
    // What comes after the record is a part of its own: it's counted when it's settled in turn.
    current = undefined;
    if (lastOpen) out.last = lastOpen;
    lastOpen = undefined;
  };
  const partAt = (at: string): SpendPart => {
    if (current && current.purpose === (purpose ?? 'orchestration')) return current;
    current = {
      purpose: purpose ?? 'orchestration',
      at,
      to: at,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      costUsd: 0,
      contextK: [],
      tools: {},
      hours: [],
    };
    pending.push(current);
    return current;
  };
  for (const line of text.split('\n')) {
    // Most lines are API requests and attachments: only these three kinds count.
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"type":"cost-state"') && !line.includes('-title"')) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (e.type === 'cost-state') {
      const t = num(e.totalCostUSD);
      // Each record is the session's total so far; a smaller one starts again (a new process that didn't carry it).
      settle(t >= total ? t - total : t);
      total = t;
      continue;
    }
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') aiTitle = e.aiTitle;
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') customTitle = e.customTitle;
    if (e.sessionId && !out.session) out.session = e.sessionId;
    if (typeof e.cwd === 'string' && !out.cwd) out.cwd = e.cwd;
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const counted = at !== undefined && Date.parse(at) > after && Date.parse(at) <= until;
    if (e.type === 'user') {
      const prompt = promptText(e);
      if (prompt !== undefined) {
        const p = promptPurpose(prompt);
        if (p) {
          agentChat ||= p.purpose !== 'orchestration';
          purpose = p.purpose;
          if (p.ticket && !out.ticket) out.ticket = p.ticket;
          if (p.agent && !out.agent) out.agent = p.agent;
        } else purpose = agentChat ? 'answer' : 'orchestration';
        continue;
      }
      if (!counted || !Array.isArray(e.message?.content)) continue;
      for (const x of e.message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (x?.type !== 'tool_result') continue;
        const size = resultSize(x.content);
        if (!size) continue;
        const part = partAt(at!);
        lastOpen = at;
        const kind = tools.get(x.tool_use_id ?? '') ?? 'other';
        part.tools[kind] = (part.tools[kind] ?? 0) + size;
      }
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const m = e.message;
    if (Array.isArray(m?.content))
      for (const x of m.content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>)
        if (x?.type === 'tool_use' && x.id) tools.set(x.id, toolKind(x.name ?? '', x.input));
    const u = m?.usage;
    if (!u || (typeof m.id === 'string' && seen.has(m.id))) continue;
    if (typeof m.id === 'string') {
      seen.add(m.id);
      if (o.seen?.has(m.id)) continue;
    }
    const usage: Usage = {
      tokens: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheCreation: num(u.cache_creation_input_tokens),
      },
      write1h: num((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens),
    };
    const weight = priceOf(typeof m.model === 'string' ? m.model : '', usage);
    if (!counted) {
      // Counted before (by an earlier read): its share of the next cost record was too. A copy has none.
      if (!(Number.isFinite(started) && at !== undefined && Date.parse(at) < started - 1000)) open.push({ part: undefined, weight });
      continue;
    }
    if (typeof m.id === 'string') o.seen?.add(m.id);
    const part = partAt(at!);
    part.to = at!;
    lastOpen = at;
    const hourAt = hourOf(at!);
    let hour = part.hours[part.hours.length - 1];
    if (hour?.at !== hourAt) part.hours.push((hour = { at: hourAt, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd: 0, turns: 0 }));
    hour.turns++;
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
      part.tokens[k] += usage.tokens[k];
      hour.tokens[k] += usage.tokens[k];
    }
    part.contextK.push(Math.round((usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheCreation) / 1000));
    open.push({ part, hour, weight });
  }
  // A title the user set wins; Flotilla's own "<worktree>: <AI title>" tag is shown as the AI title.
  const title = customTitle && !(aiTitle && customTitle.endsWith(`: ${aiTitle}`)) ? customTitle : aiTitle;
  if (title) out.title = title;
  if (o.settled) settle(undefined);
  else if (lastOpen) {
    out.open = true;
    priceOpen();
    out.live = pending;
  }
  return out;
}
