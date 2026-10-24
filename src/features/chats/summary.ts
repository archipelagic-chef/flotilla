/**
 * Summarize (BL-180): two lines on where a working agent stands, from a small model reading its transcript's last
 * part. One short headless request: no session kept, no tools, no hooks. Shared by the host and the webviews (no node
 * or vscode APIs): what goes in, the request's arguments, its answer, and how often it may run.
 */
import { oneLine } from './activity';

/** A summary of an agent's status, as its ticket shows it. */
export interface AgentSummary {
  /** Its two lines, or why it failed. */
  text?: string;
  error?: string;
  /** When it was asked (ISO 8601): the next one waits a minute from it. */
  at: string;
  /** It's being written. */
  running?: boolean;
}

/** The transcript's last items that go in (tool calls, their results, messages), and the most of them. */
export const SUMMARY_ITEMS = 30;
export const SUMMARY_CHARS = 12_000;
/** The most of one item: a long result or message is cut. */
const ITEM_CHARS = 600;
/** At most one a minute per agent. */
export const SUMMARY_EVERY_MS = 60_000;
/** The model it runs on when flotilla.agents.lightModel is unset. */
export const SUMMARY_MODEL = 'haiku';

const cut = (text: string, n = ITEM_CHARS) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A tool's input, short: its main argument when it has one, else its JSON. */
function inputOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if (Array.isArray(i.todos)) {
    const mark: Record<string, string> = { completed: 'done', in_progress: 'doing' };
    return cut(i.todos.map((t: { content?: unknown; status?: unknown }) => `${String(t?.content ?? '')} (${mark[String(t?.status)] ?? 'to do'})`).join('; '), 300);
  }
  const main = [i.command, i.file_path, i.pattern, i.url, i.query, i.description, i.path].find((v) => typeof v === 'string' && v.trim());
  return cut(typeof main === 'string' ? main : JSON.stringify(input), 300);
}

/** A tool result's text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: { type?: string; text?: unknown }) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join(' ');
}

/** One transcript line's items: "Agent: …", "Tool Bash: …", "Result: …" (failed ones said so), "User: …". */
function itemsOf(line: string): string[] {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (m.isSidechain === true || m.isMeta === true) return [];
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (m.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap((p: Record<string, unknown>) => {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) return [`Agent: ${cut(p.text)}`];
      if (p?.type === 'tool_use' && typeof p.name === 'string') return [`Tool ${p.name}: ${inputOf(p.input)}`];
      return [];
    });
  }
  if (m.type === 'user') {
    if (typeof content === 'string') return content.trim() ? [`User: ${cut(content)}`] : [];
    if (!Array.isArray(content)) return [];
    return content.flatMap((p: Record<string, unknown>) => {
      if (p?.type === 'tool_result') return [`${p.is_error === true ? 'Failed' : 'Result'}: ${cut(resultText(p.content), 300) || '(empty)'}`];
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) return [`User: ${cut(p.text)}`];
      return [];
    });
  }
  return [];
}

/**
 * What of the transcript goes in: its last `items` tool calls, results and messages, oldest first, at most `chars`
 * (the oldest dropped first). Its lines as read (JSONL), the first possibly cut: what doesn't parse is skipped.
 */
export function summaryInput(lines: readonly string[], o: { items?: number; chars?: number } = {}): string {
  const items = lines.flatMap(itemsOf).slice(-(o.items ?? SUMMARY_ITEMS));
  const chars = o.chars ?? SUMMARY_CHARS;
  let total = 0;
  const kept: string[] = [];
  for (let n = items.length - 1; n >= 0; n--) {
    total += items[n].length + 1;
    if (total > chars) break;
    kept.unshift(items[n]);
  }
  return kept.join('\n');
}

/** What it's told to do (its whole system prompt). */
export const SUMMARY_PROMPT = [
  "You summarize where a coding agent stands, from the last part of its transcript (its messages, tool calls and their results, oldest first).",
  'Answer in exactly two short lines, plain text, no Markdown headings or bullets:',
  'line 1: what it is doing now; line 2: whether anything is wrong (failing commands, loops, waiting, stuck), or "Nothing looks wrong."',
].join('\n');

/** The claude arguments: one answer, nothing kept, no tools, hooks or servers. The transcript goes on stdin. */
export function summaryArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-turns',
    '1',
    '--model',
    model,
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--system-prompt',
    SUMMARY_PROMPT,
    '--tools',
    '',
    '--strict-mcp-config',
  ];
}

/** Its answer (the json output): its two lines, or why it failed. */
export function summaryAnswer(stdout: string): { text: string } | { error: string } {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
  } catch {
    return { error: oneLine(stdout) || 'No answer.' };
  }
  const text = typeof m.result === 'string' ? m.result.trim() : '';
  if (m.is_error === true || m.subtype !== 'success' || !text) return { error: oneLine(text) || String(m.subtype ?? 'No answer.') };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  return { text: lines.map((l) => oneLine(l, 200)).join('\n') };
}

/** How long until it may run again (0: now). One running counts as just asked; one that failed may run again at once. */
export function summaryWait(last: AgentSummary | undefined, now = Date.now()): number {
  if (!last || (last.error && !last.running)) return 0;
  if (last.running) return SUMMARY_EVERY_MS;
  return Math.max(0, new Date(last.at).getTime() + SUMMARY_EVERY_MS - now);
}
