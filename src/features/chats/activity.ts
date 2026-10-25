/**
 * What a working agent is doing, read from its transcript as it works (BL-175): its current or last tool call, its
 * latest thoughts, and its todo list. The transcript's reader (chats.ts) feeds it new lines only; the views turn it
 * into a status ("now", progress, health). Shared by the host and the webviews (no node or vscode APIs).
 */

/** A tool call: what it is ("Bash", "Edit"…), its main argument, when it started (ISO 8601), and whether it returned. */
export interface ActivityTool {
  id: string;
  name: string;
  detail?: string;
  since: string;
  done?: boolean;
  failed?: boolean;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface ActivityTodo {
  text: string;
  status: TodoStatus;
  /** What it says while it's being done ("Running the tests"). */
  active?: string;
}

export interface AgentActivity {
  /** The latest tool call (the one running, or the last one). */
  tool?: ActivityTool;
  /** Its last few messages, newest last, each on one line. */
  thoughts?: string[];
  /** Its latest todo list (TodoWrite). */
  todos?: ActivityTodo[];
  /** The same command failed this many times in a row (ChatUsage.failStreak), and which. */
  failing?: { command: string; times: number };
}

/** The thoughts kept: the latest one shows, unfolding to these. */
const THOUGHTS = 3;
const LINE_CHARS = 160;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A text on one line: its first non-empty line, shortened. */
export function oneLine(text: string, max = LINE_CHARS): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A path under the chat's directory, from there. */
function relative(file: string, cwd: string | undefined): string {
  if (cwd && file.startsWith(`${cwd}/`)) return file.slice(cwd.length + 1);
  if (cwd && file.startsWith(`${cwd}\\`)) return file.slice(cwd.length + 1);
  return file;
}

/** A tool call's main argument: the command, the file, the pattern… */
function detailOf(name: string, input: Record<string, unknown> | undefined, cwd: string | undefined): string | undefined {
  if (!input) return undefined;
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str(input.command) && oneLine(String(input.command), 120);
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return file && relative(file, cwd);
    case 'Grep':
    case 'Glob':
      return str(input.pattern);
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'Agent':
    case 'Task':
      return str(input.description);
    default:
      return file ? relative(file, cwd) : undefined;
  }
}

function todosOf(input: Record<string, unknown> | undefined): ActivityTodo[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  return (input.todos as Array<Record<string, unknown>>).flatMap((t) => {
    const text = str(t?.content);
    const status = t?.status;
    if (!text || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return [];
    const active = str(t.activeForm);
    return [{ text: oneLine(text), status, ...(active ? { active: oneLine(active) } : {}) }];
  });
}

/**
 * An agent's reply (its message's content parts), added to what it's doing: its text is its latest thought, its last
 * tool call is what it does now, a TodoWrite call is its new todo list. Returns a new activity (the old one is kept by
 * the reader's cache).
 */
export function noteReply(was: AgentActivity | undefined, content: unknown, timestamp: unknown, cwd?: unknown): AgentActivity | undefined {
  if (!Array.isArray(content)) return was;
  let next = was;
  const since = typeof timestamp === 'string' ? timestamp : new Date().toISOString();
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.type === 'text' && str(part.text)) {
      next = { ...next, thoughts: [...(next?.thoughts ?? []), oneLine(String(part.text))].slice(-THOUGHTS) };
    } else if (part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
      const input = part.input as Record<string, unknown> | undefined;
      const detail = detailOf(part.name, input, typeof cwd === 'string' ? cwd : undefined);
      const todos = part.name === 'TodoWrite' ? todosOf(input) : undefined;
      next = { ...next, tool: { id: part.id, name: part.name, ...(detail ? { detail } : {}), since }, ...(todos ? { todos } : {}) };
    }
  }
  return next;
}

/** Tool results (a user line's content parts): the current call returned, or failed. */
export function noteResults(was: AgentActivity | undefined, content: unknown): AgentActivity | undefined {
  const tool = was?.tool;
  if (!tool || tool.done || !Array.isArray(content)) return was;
  const result = (content as Array<Record<string, unknown>>).find((p) => p?.type === 'tool_result' && p.tool_use_id === tool.id);
  if (!result) return was;
  return { ...was, tool: { ...tool, done: true, ...(result.is_error === true ? { failed: true } : {}) } };
}

/** Whether a tool call waits for its result (the reader then looks at results). */
export function waitsForResult(a: AgentActivity | undefined): boolean {
  return !!a?.tool && !a.tool.done;
}

// What the views show.

/** "2:10", "1:02:05": how long it has run. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** The ticket's own file in the backlog: "Reading the ticket" reads better than its path. */
const TICKET_FILE = /(?:^|[\\/])\.flotilla[\\/]backlog[\\/][A-Za-z]+-\d+\.md$/;

const VERBS: Record<string, string> = {
  Bash: 'Running',
  PowerShell: 'Running',
  Read: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Grep: 'Searching for',
  Glob: 'Looking for files',
  WebFetch: 'Fetching',
  WebSearch: 'Searching the web for',
  Agent: 'Asking a subagent:',
  Task: 'Asking a subagent:',
  TodoWrite: 'Updating its plan',
};
const CODE = new Set(['Bash', 'PowerShell', 'Grep', 'Glob']);

/** What a tool call does, as a phrase: "Running `npm test`", "Editing src/a.ts", "Reading the ticket". */
export function toolPhrase(tool: Pick<ActivityTool, 'name' | 'detail'>): string {
  const detail = tool.detail;
  if (detail && TICKET_FILE.test(detail) && (tool.name === 'Read' || tool.name === 'Edit' || tool.name === 'Write')) {
    return `${tool.name === 'Read' ? 'Reading' : 'Writing to'} the ticket`;
  }
  const verb = VERBS[tool.name] ?? (tool.name.startsWith('mcp__') ? `Using ${tool.name.split('__').slice(1).join(' ')}` : `Using ${tool.name}`);
  if (!detail || tool.name === 'TodoWrite') return verb;
  return `${verb} ${CODE.has(tool.name) ? `\`${detail}\`` : detail}`;
}

/** Its "now": the call running and for how long, or the last one. */
export function nowLine(a: AgentActivity, now = Date.now()): { text: string; running: boolean } | undefined {
  if (!a.tool) return undefined;
  if (a.tool.done) return { text: `${a.tool.failed ? 'Failed: ' : 'Last: '}${toolPhrase(a.tool)}`, running: false };
  return { text: `${toolPhrase(a.tool)} · ${clock(now - new Date(a.tool.since).getTime())}`, running: true };
}

/** Its plan's progress: "4 of 7", and the step it's on. */
export function progress(a: AgentActivity): { done: number; total: number; current?: string } | undefined {
  const todos = a.todos;
  if (!todos?.length) return undefined;
  const step = todos.find((t) => t.status === 'in_progress');
  return { done: todos.filter((t) => t.status === 'completed').length, total: todos.length, ...(step ? { current: step.active ?? step.text } : {}) };
}

/** The thresholds of the "looks stuck" rules (flotilla.agents.stuck.*). 0 switches one off. */
export interface StuckRules {
  /** No transcript writes for this many minutes, while its process runs. */
  silentMinutes: number;
  /** The same command failed this many times in a row. */
  repeatedFailures: number;
  /** One command has run longer than this many minutes. */
  commandMinutes: number;
}

export const DEFAULT_STUCK_RULES: StuckRules = { silentMinutes: 10, repeatedFailures: 3, commandMinutes: 15 };

export interface Health {
  /** "active 20 s ago", or why it looks stuck: "No activity for 14 min". */
  text: string;
  stuck: boolean;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

/** "20 s", "3 min", "2 h 5 min". */
function since(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/**
 * How it's doing: when it last wrote its transcript, or a warning when it looks stuck. A command running long comes
 * first (it says what to look at), then a failure repeated, then silence. Silence counts only while its process runs
 * (`running`): an agent that waits for you is quiet on purpose.
 */
export function health(a: AgentActivity | undefined, lastWrite: string, rules: StuckRules, running: boolean, now = Date.now()): Health {
  const quiet = now - new Date(lastWrite).getTime();
  const tool = a?.tool;
  if (rules.commandMinutes > 0 && tool && !tool.done && CODE.has(tool.name) && tool.detail) {
    const ran = now - new Date(tool.since).getTime();
    if (minutes(ran) >= rules.commandMinutes) return { text: `\`${oneLine(tool.detail, 60)}\` running for ${since(ran)}`, stuck: true };
  }
  if (rules.repeatedFailures > 0 && a?.failing && a.failing.times >= rules.repeatedFailures) {
    return { text: `Same command failed ${a.failing.times} times: \`${oneLine(a.failing.command, 60)}\``, stuck: true };
  }
  // A long command writes nothing while it runs (the rule above judges it), nor does a subagent (it has its own transcript).
  const waiting = tool && !tool.done && (CODE.has(tool.name) || tool.name === 'Agent' || tool.name === 'Task');
  if (running && !waiting && rules.silentMinutes > 0 && minutes(quiet) >= rules.silentMinutes) return { text: `No activity for ${since(quiet)}`, stuck: true };
  return { text: `active ${since(quiet)} ago`, stuck: false };
}

/** The backlog card's one line: "now", with progress ("Running `npm test` · 2:10 · 4 of 7"). */
export function statusLine(a: AgentActivity, now = Date.now()): string | undefined {
  const p = progress(a);
  const line = nowLine(a, now)?.text ?? a.thoughts?.at(-1);
  if (!line && !p) return undefined;
  return [line, p && `${p.done} of ${p.total}`].filter(Boolean).join(' · ');
}
