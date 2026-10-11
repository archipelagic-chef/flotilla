import { entryAgent } from './backlog';
import type { TicketEntry } from './ticket';

/**
 * How a run block runs: shell commands, one after the other (the default); a debug configuration of the worktree's
 * launch.json, or a task of its tasks.json, by name; or a URL or a file in the worktree to open.
 */
export type RunKind = 'shell' | 'launch' | 'task' | 'open';

export interface RunBlock {
  kind: RunKind;
  /** The text after "run" (and after the kind, if there is one), '' when there's none. */
  title: string;
  /**
   * The body's non-blank lines, trimmed: the commands for shell; for launch, task and open, the name, URL or path (the
   * title, when the body is empty).
   */
  lines: string[];
}

const KINDS: readonly RunKind[] = ['launch', 'task', 'open'];

/** An opening or closing fence: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The run blocks in a text (an agent's report): fenced blocks whose info string starts with "run", e.g.
 * "```run Build and open a test window". Only closed fences count, and a fence inside another (an example) is part of
 * that one, so it's not a run block.
 */
export function runBlocks(text: string): RunBlock[] {
  const blocks: RunBlock[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    const [, fence, info] = open;
    // A backtick fence's info string has no backticks: otherwise the line is inline code.
    if (fence[0] === '`' && info.includes('`')) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length && close < 0; j++) {
      const end = FENCE.exec(lines[j]);
      if (end && end[1][0] === fence[0] && end[1].length >= fence.length && end[2].trim() === '') close = j;
    }
    // Unclosed: the fence runs to the end of the text, so nothing after it is a run block.
    if (close < 0) break;
    const run = /^run(?:\s+(.*))?$/.exec(info.trim());
    if (run) blocks.push(parseRun(run[1] ?? '', lines.slice(i + 1, close)));
    i = close;
  }
  return blocks;
}

function parseRun(head: string, body: string[]): RunBlock {
  const words = head.trim();
  const first = /^(\S+)(?:\s+(.*))?$/.exec(words);
  const kind = first && (KINDS as readonly string[]).includes(first[1]) ? (first[1] as RunKind) : 'shell';
  const title = (kind === 'shell' ? words : (first?.[2] ?? '')).trim();
  const lines = body.map((l) => l.trim()).filter(Boolean);
  if (kind !== 'shell' && lines.length === 0 && title) lines.push(title);
  return { kind, title, lines };
}

/**
 * The run blocks reported in a ticket's activity, in order: only in the entries of agents and of Flotilla. Comments
 * (the user's, or ones synced from Jira or GitHub) and the description don't count.
 */
export function activityRuns(activity: TicketEntry[]): RunBlock[] {
  return activity
    .filter((e) => entryAgent(e.author) || e.author.trim() === 'Flotilla')
    .flatMap((e) => runBlocks(e.body));
}

/** The ticket's run: the last run block reported. */
export function ticketRun(activity: TicketEntry[]): RunBlock | undefined {
  return activityRuns(activity).at(-1);
}
