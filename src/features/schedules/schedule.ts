import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_EFFORTS,
  type AgentEffort,
} from '../backlog/backlog';

/**
 * Scheduled tasks (BL-260): each is a Markdown file in the backlog's `schedules/` folder, its front matter saying when
 * it runs and its body what its agent does. Each run's report is kept in the task's folder, one a day at most
 * (`schedules/<task>/YYYY-MM-DD.md`); the newest one is when it last ran.
 *
 * ```markdown
 * ---
 * every: Mondays at 06:00   # or "7 days", "day at 06:00"; or once: 2026-11-07
 * when: idle                # the default: only when no agent works or waits; any: whenever a slot is free
 * model: opus               # optional, as flotilla.agents.model
 * effort: high              # optional
 * tools: Bash(npm run demo:*)  # optional: more tools its agent may use, comma-separated Claude Code rules
 * ---
 * What the agent does, and what its report says.
 * ```
 */
export const SCHEDULES_DIR = 'schedules';

export type TaskWhen = 'idle' | 'any';

/** When a task runs. at: minutes after midnight, local time. */
export type Schedule =
  { kind: 'days'; days: number; at?: number } | { kind: 'weekly'; weekdays: number[]; at: number } | { kind: 'once'; date: string; at?: number };

export interface ScheduledTask {
  /** The file's name without .md: its folder's name, and what its proposals say they're proposed by. */
  name: string;
  /** What its reports are headed with (title:, else its name in words). */
  title: string;
  schedule: Schedule;
  when: TaskWhen;
  model?: string;
  effort?: AgentEffort;
  /** Tools its agent may use besides reading and writing its report (tools:), as Claude Code's permission rules. */
  tools?: string[];
  /** The agent's instructions: the file's body. */
  instructions: string;
  /** Proposed by this agent through the inbox: it runs only once the user accepts it. */
  proposed?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function schedulesDir(backlogDir: string): string {
  return path.join(backlogDir, SCHEDULES_DIR);
}

/** The folder a task's reports are kept in. */
export function taskDir(backlogDir: string, name: string): string {
  return path.join(schedulesDir(backlogDir), name);
}

/** A day's local date, as a report's name. */
export function taskDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** Whether a name may be a task's: lower case letters, digits and dashes (it's a folder and a file name). */
export function validTaskName(name: string): boolean {
  return NAME.test(name);
}

/** "---" front matter (key: value lines, # comments dropped) and the rest. */
export function frontMatter(text: string): { fields: Map<string, string>; body: string; found: boolean } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  const fields = new Map<string, string>();
  for (const line of (front?.[1] ?? '').split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line.replace(/\s+#.*$/, ''));
    if (m) fields.set(m[1].toLowerCase(), m[2].replace(/^["']|["']$/g, ''));
  }
  return { fields, body: front ? normalized.slice(front[0].length) : normalized, found: !!front };
}

/** "06:00", "6:30", "at 18:00" as minutes after midnight; undefined when it isn't a time. */
function parseTime(s: string): number | undefined {
  const m = /^(?:at\s+)?(\d{1,2}):(\d{2})$/i.exec(s.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Splits "<what> [at] HH:MM" into the what and the time. */
function splitTime(s: string): { what: string; at?: number } | { error: string } {
  const m = /^(.*?)\s*(?:\bat\s+)?(\d{1,2}:\d{2})$/i.exec(s.trim());
  if (!m) return { what: s.trim() };
  const at = parseTime(m[2]);
  return at === undefined ? { error: `"${m[2]}" isn't a time of day (HH:MM).` } : { what: m[1].trim(), at };
}

/** every: "7 days", "day", "2 weeks", "Mondays at 06:00", "Monday, Thursday 18:00". */
export function parseEvery(text: string): Schedule | { error: string } {
  const split = splitTime(text);
  if ('error' in split) return split;
  const what = split.what.toLowerCase();
  const n = /^(\d+)?\s*(day|days|week|weeks)$/.exec(what) ?? (what === 'daily' ? [what, '1', 'day'] : what === 'weekly' ? [what, '1', 'week'] : null);
  if (n) {
    const count = Number(n[1] ?? 1) * (n[2].startsWith('week') ? 7 : 1);
    if (!(count > 0)) return { error: `"every: ${text}" runs it never: give a number of days of at least 1.` };
    return { kind: 'days', days: count, ...(split.at !== undefined ? { at: split.at } : {}) };
  }
  const weekdays: number[] = [];
  for (const word of what.split(/\s*(?:,|\band\b)\s*/).filter(Boolean)) {
    const day = WEEKDAYS.findIndex((d) => word === d || word === `${d}s` || (word.length >= 3 && d.startsWith(word.replace(/s$/, ''))));
    if (day < 0) return { error: `"every: ${text}" isn't a schedule: write a number of days ("7 days") or weekdays and a time ("Mondays at 06:00").` };
    if (!weekdays.includes(day)) weekdays.push(day);
  }
  if (!weekdays.length) return { error: 'every: is empty: write a number of days ("7 days") or weekdays and a time ("Mondays at 06:00").' };
  return { kind: 'weekly', weekdays: weekdays.sort(), at: split.at ?? 0 };
}

/** once: "2026-11-07", "2026-11-07 at 09:00". */
export function parseOnce(text: string): Schedule | { error: string } {
  const split = splitTime(text);
  if ('error' in split) return split;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(split.what);
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3]))
    return { error: `"once: ${text}" isn't a date (YYYY-MM-DD, and a time if you like).` };
  return { kind: 'once', date: split.what, ...(split.at !== undefined ? { at: split.at } : {}) };
}

/** Reads a task's file: what's wrong with it, when it can't run. */
export function parseTask(name: string, text: string): ScheduledTask | { error: string } {
  if (!validTaskName(name)) return { error: `"${name}" can't be a task's name: use lower case letters, digits and dashes.` };
  const { fields, body, found } = frontMatter(text);
  if (!found) return { error: 'It has no front matter: start it with "---", an "every:" or "once:" line, and "---".' };
  const every = fields.get('every');
  const once = fields.get('once');
  if (every && once) return { error: 'It has both every: and once:; give one of them.' };
  if (!every && !once) return { error: 'It says not when it runs: add "every: 7 days", "every: Mondays at 06:00" or "once: 2026-11-07".' };
  const schedule = every ? parseEvery(every) : parseOnce(once!);
  if ('error' in schedule) return schedule;
  const when = (fields.get('when') ?? 'idle').toLowerCase();
  if (when !== 'idle' && when !== 'any') return { error: `"when: ${fields.get('when')}" is neither idle (the default) nor any.` };
  const effort = fields.get('effort')?.toLowerCase();
  if (effort && !AGENT_EFFORTS.includes(effort as AgentEffort)) return { error: `"effort: ${effort}" isn't one of ${AGENT_EFFORTS.join(', ')}.` };
  const tools = parseTools(fields.get('tools') ?? '');
  if ('error' in tools) return tools;
  const instructions = body.trim();
  if (!instructions) return { error: 'It has no instructions: write what the agent does after the front matter.' };
  const title = fields.get('title') || name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');
  return {
    name,
    title,
    schedule,
    when,
    ...(fields.get('model') ? { model: fields.get('model') } : {}),
    ...(effort ? { effort: effort as AgentEffort } : {}),
    ...(tools.length ? { tools } : {}),
    instructions,
    ...(fields.get('proposed') ? { proposed: fields.get('proposed') } : {}),
  };
}

/** Tools nobody watching may run only with a rule that narrows them: a bare Bash would run any command. */
const NARROWED = ['Bash', 'Edit', 'Write', 'NotebookEdit'];

/** tools: "Bash(npm run demo:*), WebFetch" as its rules; commas inside a rule's parentheses don't split it. */
export function parseTools(text: string): string[] | { error: string } {
  const rules = text
    .split(/,(?![^()]*\))/)
    .map((r) => r.trim())
    .filter(Boolean);
  for (const rule of rules) {
    const m = /^([A-Za-z][\w-]*)(\((.+)\))?$/.exec(rule);
    if (!m) return { error: `"tools: ${text}": "${rule}" isn't a tool's rule, such as Bash(npm run demo:*).` };
    if (NARROWED.includes(m[1]) && !m[3]?.trim())
      return { error: `"tools: ${text}": ${m[1]} needs what it may do, such as ${m[1]}(npm run demo:*): nobody watches the run.` };
  }
  return rules;
}

/** A schedule in words: "every 7 days", "Mondays at 06:00", "once on 2026-11-07". */
export function scheduleText(s: Schedule): string {
  const at = (m: number | undefined) => (m === undefined ? '' : ` at ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  if (s.kind === 'days') return `${s.days === 1 ? 'every day' : `every ${s.days} days`}${at(s.at)}`;
  if (s.kind === 'once') return `once on ${s.date}${at(s.at)}`;
  const names = s.weekdays.map((d) => `${WEEKDAYS[d].charAt(0).toUpperCase()}${WEEKDAYS[d].slice(1)}s`);
  return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}${at(s.at)}`;
}

/** Local midnight of a YYYY-MM-DD day, plus minutes. */
function dayAt(day: string, minutes = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, minutes);
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days, at.getHours(), at.getMinutes());
}

/**
 * When a task runs next: from its last report's day (last), or, before its first run, from when it was made (created).
 * A time in the past is due now: runs missed while the window was closed are made up once, not once each, since the
 * next one counts from that run's day. Undefined: never again (a once: task that ran).
 */
export function nextRun(s: Schedule, o: { last?: string; created: Date }): Date | undefined {
  if (s.kind === 'once') return o.last ? undefined : dayAt(s.date, s.at);
  if (s.kind === 'days') {
    if (o.last) return addDays(dayAt(o.last, s.at ?? 0), s.days);
    // Its first run: at once, or at its time of day from the day it was made.
    if (s.at === undefined) return o.created;
    const today = dayAt(taskDay(o.created), s.at);
    return today >= o.created ? today : addDays(today, 1);
  }
  // Weekly: the first of its times after the last run's day (or after it was made).
  const from = o.last ? dayAt(o.last, 24 * 60) : o.created;
  for (let i = 0; i <= 7; i++) {
    const at = dayAt(taskDay(addDays(from, i)), s.at);
    if (s.weekdays.includes(at.getDay()) && at >= from) return at;
  }
  return undefined;
}

/** Whether a task is due now (see nextRun). */
export function taskDue(s: Schedule, o: { last?: string; created: Date; now: Date }): boolean {
  const next = nextRun(s, o);
  return !!next && next.getTime() <= o.now.getTime();
}

/** What a scheduled run is held by: the autopilot's view (AutopilotView's fields). */
export interface RunConditions {
  running: number;
  waiting: number;
  waitingUntil?: string;
  pausedAll?: number;
  enabled: boolean;
  idle?: string;
  elsewhere: boolean;
}

/**
 * What keeps a task from starting now; undefined when it may (given a free slot). Never in a window that doesn't lead,
 * nor while Pause All is on or a usage limit holds; "idle" tasks (and the improvement review) also wait until no
 * agent works or waits and the autopilot has nothing to start.
 */
export function taskBlocked(v: RunConditions, when: TaskWhen = 'idle'): string | undefined {
  if (v.elsewhere) return 'another window runs the autopilot';
  if (v.pausedAll) return 'all agents are paused';
  if (v.waitingUntil) return 'agents wait for a usage limit';
  if (when === 'any') return undefined;
  if (v.running) return `${v.running === 1 ? 'an agent is' : `${v.running} agents are`} working`;
  if (v.waiting) return 'starts are waiting for a slot';
  if (v.enabled && !v.idle) return 'the autopilot has tickets to start';
  return undefined;
}

/** A task's reports, newest first, as their days. */
export async function listTaskReports(backlogDir: string, name: string): Promise<string[]> {
  const names = await fs.promises.readdir(taskDir(backlogDir, name)).catch(() => [] as string[]);
  return names
    .flatMap((n) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n)?.[1] ?? [])
    .sort()
    .reverse();
}

/**
 * The only tools a task's agent has: reading anything, and writing its report (and files for it, named after its day,
 * such as a diagram's SVG) and its proposals. As the review's (reviewTools): Write is offered and allowed only where
 * the Edit(path) rules say. A task's tools: line adds its rules (more).
 */
export function taskTools(o: { reportFile: string; inboxDir: string; name: string; more?: string[] }): { tools: string[]; offer: string[] } {
  const abs = (p: string) => `//${p.replace(/^\/+/, '')}`;
  const day = path.basename(o.reportFile, '.md');
  return {
    tools: [
      'Read',
      'Grep',
      'Glob',
      `Edit(${abs(o.reportFile)})`,
      `Edit(${abs(path.dirname(o.reportFile))}/${day}-*)`,
      `Edit(${abs(o.inboxDir)}/${o.name}-*.md)`,
      ...(o.more ?? []),
    ],
    offer: ['Write'],
  };
}

/** The line each of a task's proposals has in its description: how a proposal says which task made it. */
export function proposedByLine(name: string): string {
  return `Proposed by: ${name}`;
}

export interface TaskPromptInput {
  agent: string;
  task: ScheduledTask;
  day: string;
  reportFile: string;
  /** Its earlier reports' files, newest first. */
  earlier: string[];
  inboxDir: string;
  mainRoot: string;
  backlogDir: string;
}

/** A task's prompt: its instructions, its earlier reports, and what it writes where. */
export function taskPrompt(o: TaskPromptInput): string {
  const { task } = o;
  const day = path.basename(o.reportFile, '.md');
  return [
    `You are agent ${o.agent}, running Flotilla's scheduled task "${task.name}" (${scheduleText(task.schedule)}) on ${o.day}. Flotilla runs coding agents on a backlog of tickets. Nobody watches this run: do what the instructions say, write your report, and propose tickets for what's worth doing.`,
    `## Your instructions\n\n${task.instructions}`,
    [
      `## Earlier runs`,
      o.earlier.length
        ? `Their reports, newest first:\n${o.earlier.map((f) => `- ${f}`).join('\n')}\n\nRead the last one: check what it proposed (the tickets with the line "${proposedByLine(task.name)}" in ${o.backlogDir}), whether each was accepted and done, and whether it helped. Say so in your report.`
        : 'This is its first run.',
    ].join('\n\n'),
    `## Where things are\n\nYou can read, not change: the repository at ${o.mainRoot}, and the backlog at ${o.backlogDir} (backlog.json: the tickets with their status; each ticket's <id>.md with its activity). Don't propose what an open ticket already covers: name it in your report instead.${task.tools?.length ? ` Besides that, your task gives you: ${task.tools.join(', ')} (the commands run in ${o.mainRoot}).` : ''}`,
    [
      `## What you write`,
      `1. Your report, with the Write tool, to ${o.reportFile} (you may write no other file but those below). In Markdown: "# ${task.title} ${o.day}", then a summary of at most three lines, then what your instructions ask for. Link code from the repository root with its lines, like [src/a.ts:42](src/a.ts#L42); tickets by their ids (BL-12). A diagram as a \`\`\`mermaid block; an image as a file next to the report named ${day}-<name> (.svg), shown with ![What it shows](${day}-<name>.svg).`,
      [
        `2. Each proposal, with the Write tool, as a file ${o.inboxDir}/${task.name}-${o.day}-<n>.md (n = 1, 2, …), which Flotilla turns into a proposed ticket for the user to accept or dismiss:`,
        [
          '   ```markdown',
          '   ---',
          `   agent: ${o.agent}`,
          '   priority: medium',
          '   ---',
          '   # A short title: what is true once it is done',
          '',
          "   **When it's done:** what the user sees or gets.",
          '',
          '   **Why:** what you found, with its evidence.',
          '',
          `   ${proposedByLine(task.name)}`,
          '',
          '   Acceptance criteria:',
          '   - [ ] ...',
          '   ```',
        ].join('\n'),
        `   Keep the "${proposedByLine(task.name)}" line: the next run finds its proposals by it. Name each proposal in your report.`,
      ].join('\n'),
      `3. Your final message: the report's summary (at most three lines), nothing else.`,
    ].join('\n'),
  ].join('\n\n');
}

/** A task an agent proposes through the inbox (front matter schedule: <name>): its name and the file to save. */
export function proposedTask(text: string): { name: string; file: string; task: ScheduledTask } | { error: string } {
  const { fields, body } = frontMatter(text);
  const name = (fields.get('schedule') ?? '').toLowerCase();
  const agent = fields.get('agent')?.replace(/^agent\s+/i, '');
  const kept = [...fields].filter(([k]) => !['schedule', 'agent', 'proposed'].includes(k));
  const file = `---\n${kept.map(([k, v]) => `${k}: ${v}`).join('\n')}\nproposed: ${agent || 'an agent'}\n---\n${body.trim()}\n`;
  const task = parseTask(name, file);
  return 'error' in task ? task : { name, file, task };
}

/** A proposed task's file once accepted: without its proposed: line, so it runs. */
export function acceptedTask(text: string): string {
  return text.replace(/^(---\r?\n[\s\S]*?)^proposed:.*\r?\n/m, '$1');
}
