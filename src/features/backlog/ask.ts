/**
 * Ask (BL-80): a small chat about a ticket, off the record. One Claude Code process per open ticket answers the
 * questions: it reads (files and git) and changes nothing, and nothing of it is kept, in the ticket or on disk.
 *
 * The process takes the questions on stdin and streams its answers on stdout (stream-json both ways), so a follow-up
 * goes on in the same chat and an answer can be stopped (an interrupt) without ending it.
 */
import { leanFlags } from './leanStart';
import type { TicketEntry } from './ticket';

/** What it may run: reads, and git's read-only commands. With dontAsk, everything else is refused. */
export const ASK_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)'] as const;

/** git's options that write files or run programs, refused even on the read-only commands. */
export const ASK_DENIED = ['Bash(git *--output*)', 'Bash(git *--ext-diff*)'] as const;

/** Its tools, by name: the rules above narrow Bash to git's reads. */
export const ASK_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;

/**
 * Its settings: no hooks (Flotilla's hook would record it as a chat of the ticket's worktree, which agents and the
 * ticket show, and would hand it the backlog guide), and the plugins the user enabled switched off (a lean start).
 */
export function askSettings(plugins: readonly string[]): string {
  return JSON.stringify({ disableAllHooks: true, ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) } : {}) });
}

/** The claude arguments of an Ask process: streaming in and out, nothing kept, read-only, lean. */
export function askArgs(o: { model?: string; instructions: string; plugins: readonly string[] }): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    ...(o.model ? ['--model', o.model] : []),
    '--append-system-prompt',
    o.instructions,
    ...leanFlags(undefined),
    '--settings',
    askSettings(o.plugins),
    '--disallowedTools',
    ...ASK_DENIED,
    '--tools',
    ASK_TOOLS.join(','),
    '--allowedTools',
    ...ASK_ALLOWED,
  ];
}

/** What it's told about its part (the system prompt's addition). */
export function askInstructions(ticket: { id: string; title: string }): string {
  return [
    `You answer the user's questions about backlog ticket ${ticket.id} ("${ticket.title}"), in a small chat in the ticket's view.`,
    "The chat is off the record: it isn't written to the ticket, and the agents working on the ticket don't see it.",
    'You only read: files (Read, Grep, Glob) and git (git log, git diff, git show, git status). Change nothing, and run nothing else.',
    'The first message gives the ticket and its branch: answer from it when it suffices, and look in the code only when the question needs it.',
    'Answer briefly, in Markdown. Link files by their path from the repository root, with lines: [src/a.ts:42](src/a.ts#L42).',
  ].join('\n');
}

/** The most of the description, and of the latest activity, that the first message carries. */
const DESCRIPTION_CHARS = 8000;
const ACTIVITY_CHARS = 6000;
const ACTIVITY_ENTRIES = 4;

const cap = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}\n[…cut; the whole ticket is in the file]` : text);

/** A question asked in the ticket's Ask chat (BL-80), and its answer so far. */
export interface AskTurn {
  question: string;
  /** Markdown: as it streams in, then the answer as it ended. */
  answer: string;
  /** The answer rendered, once it's finished. */
  html?: string;
  state: 'waiting' | 'answering' | 'done' | 'stopped' | 'failed';
  /** What it's doing now: "Reading src/a.ts", "Waiting for memory…". */
  activity?: string;
  error?: string;
  /** It was posted to the ticket as a comment. */
  posted?: boolean;
}

/** The ticket's Ask chat: off the record, in this tab only. */
export interface AskView {
  turns: AskTurn[];
  /** The model it answers with (flotilla.ask.model). */
  model: string;
  /** A question is underway (or a stopped answer hasn't ended yet): the next one waits. */
  busy: boolean;
}

/** What a chat starts with: the ticket, its latest activity, and its branch's state. */
export interface AskContext {
  id: string;
  title: string;
  status: string;
  /** The ticket file, for the whole of it. */
  file?: string;
  description: string;
  activity: readonly TicketEntry[];
  /** The worktree it's worked in (the process's folder), and its branch. */
  worktree?: { path: string; branch?: string; changes: string };
  /** The branch's commits not on the base (newest first), and the files it changes. */
  base?: string;
  commits: ReadonlyArray<{ short: string; subject: string }>;
  diffStat?: string;
}

/** Git's output without the blank lines around it; its lines' leading spaces mean something (git status). */
const gitBlock = (text: string) => text.replace(/^\s*\n/, '').trimEnd();

/** The context, as the first message's start. */
export function askContextText(c: AskContext): string {
  const latest = c.activity.slice(-ACTIVITY_ENTRIES);
  let activity = latest.map((e) => `### ${e.date} · ${e.author}\n${e.body.trim()}`).join('\n\n');
  activity = activity.length > ACTIVITY_CHARS ? `[…]\n${activity.slice(-ACTIVITY_CHARS)}` : activity;
  const parts = [
    `# ${c.id}: ${c.title}`,
    `Status: ${c.status}.${c.file ? ` The ticket file: ${c.file}` : ''}`,
    `## Description\n\n${cap(c.description.trim(), DESCRIPTION_CHARS) || '(none)'}`,
    `## Latest activity (${latest.length} of ${c.activity.length} entries, newest last)\n\n${activity || '(none)'}`,
  ];
  const branch: string[] = [];
  if (c.worktree) branch.push(`Worktree: ${c.worktree.path} (the folder you're in), on branch ${c.worktree.branch ?? '(detached)'}.`);
  else branch.push('No worktree: you are in the main one.');
  if (c.commits.length) {
    branch.push(`Commits not on ${c.base ?? 'the base'} (newest first):\n${c.commits.slice(0, 20).map((x) => `- ${x.short} ${x.subject}`).join('\n')}${c.commits.length > 20 ? `\n- … ${c.commits.length - 20} more` : ''}`);
  } else branch.push(`No commits of its own${c.base ? ` (not on ${c.base})` : ''} yet.`);
  if (c.diffStat?.trim()) branch.push(`What they change (git diff --stat ${c.base ?? ''}...):\n${gitBlock(c.diffStat)}`);
  if (c.worktree) branch.push(c.worktree.changes.trim() ? `Uncommitted (git status --short):\n${gitBlock(c.worktree.changes)}` : 'No uncommitted changes.');
  parts.push(`## Branch\n\n${branch.join('\n\n')}`);
  return parts.join('\n\n');
}

/** An earlier part of the chat, given again when its process had to start over. */
export function earlierText(turns: ReadonlyArray<{ question: string; answer: string }>): string {
  return turns.length ? `## Earlier in this chat\n\n${turns.map((t) => `Q: ${t.question}\n\nA: ${t.answer}`).join('\n\n')}` : '';
}

/** A user message, as stream-json input takes it (one line). */
export function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/** The request that stops the answer being written (the chat goes on). */
export function interruptRequest(id: string): string {
  return `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })}\n`;
}

/** What a line of its output says, as far as the chat shows it. */
export type AskEvent =
  /** The process is up (its memory counts as its own from now). */
  | { kind: 'ready' }
  /** A new message of the answer starts (after a tool, the text goes on in a new paragraph). */
  | { kind: 'message' }
  | { kind: 'text'; text: string }
  /** It's looking at something: "Reading src/a.ts". */
  | { kind: 'tool'; label: string }
  /** The answer is finished: its text, or why it failed (stopped: it was interrupted). */
  | { kind: 'result'; text?: string; error?: string };

const short = (s: unknown, n = 80) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A tool call, as it shows while the answer is written. */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Reading ${short(input.file_path)}`;
    case 'Grep':
      return `Searching for ${short(input.pattern, 50)}`;
    case 'Glob':
      return `Looking for ${short(input.pattern, 50)}`;
    case 'Bash':
      return `Running ${short(input.command)}`;
    default:
      return `Using ${name}`;
  }
}

/** Parses a line of the process's output; undefined for what the chat doesn't show. */
export function askEvent(line: string): AskEvent | undefined {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (m.type === 'system' && m.subtype === 'init') return { kind: 'ready' };
  if (m.type === 'stream_event') {
    const e = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (e?.type === 'message_start') return { kind: 'message' };
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') return { kind: 'text', text: e.delta.text };
    return undefined;
  }
  if (m.type === 'assistant') {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    const tool = Array.isArray(content) ? content.find((c: { type?: string }) => c?.type === 'tool_use') : undefined;
    return tool ? { kind: 'tool', label: toolLabel(String(tool.name), (tool.input ?? {}) as Record<string, unknown>) } : undefined;
  }
  if (m.type === 'result') {
    const text = typeof m.result === 'string' ? m.result : undefined;
    if (m.is_error || m.subtype !== 'success') {
      const errors = Array.isArray(m.errors) ? m.errors.filter((x): x is string => typeof x === 'string').join(' ') : '';
      return { kind: 'result', error: text || errors || String(m.subtype ?? 'error') };
    }
    return { kind: 'result', text: text ?? '' };
  }
  return undefined;
}

/** Splits a stream into lines: feed it chunks, get the whole lines so far (the rest waits for the next chunk). */
export class LineBuffer {
  private rest = '';
  push(chunk: string): string[] {
    const lines = (this.rest + chunk).split('\n');
    this.rest = lines.pop() ?? '';
    return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  }
}

/** A posted answer, as the comment it becomes: the question, then the answer. */
export function postedAnswer(question: string, answer: string, model?: string): string {
  const quoted = question
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
  return `Asked about this ticket${model ? ` (Ask, ${model})` : ''}:\n\n${quoted}\n\n${answer.trim()}`;
}
