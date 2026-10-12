/**
 * What a ticket's state card says: what's happening now, and what an agent asks of the user. Pure (no DOM, no vscode),
 * so the rules are tested apart from the view.
 */
import { entryAgent, type BacklogStatus } from '../features/backlog/backlog';

/** A question an agent reports, with its numbered options (each one a button). */
export interface Ask {
  question: string;
  options: string[];
}

export interface StatusEntry {
  date: string;
  author: string;
  body: string;
}

export interface StatusInput {
  status: BacklogStatus;
  review?: { state: string; running: boolean };
  agents: Array<{ agent: string; state: string; started: string; message?: string }>;
  activity: StatusEntry[];
  /** Whether it has worktrees (or branches): work exists, though nothing runs. */
  hasWork: boolean;
  now?: number;
}

export type StatusTone = 'waiting' | 'working' | 'done' | 'idle';

export interface TicketStatus {
  tone: StatusTone;
  title: string;
  detail?: string;
  ask?: Ask;
}

const OPTION = /^\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
const WAITING = /^\W*waiting for you\W*$/i;

/**
 * The question in an agent's report, and its numbered options (the last run of two or more numbered lines, as
 * buttons). The question is the rest of the report, without the "Waiting for you." line.
 */
export function askOf(body: string): Ask {
  const lines = body.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => !WAITING.test(l.trim()));
  let end = lines.length;
  while (end > 0 && !OPTION.test(lines[end - 1])) end--;
  let start = end;
  while (start > 0 && OPTION.test(lines[start - 1])) start--;
  const runs = end - start >= 2;
  const options = runs ? lines.slice(start, end).map((l) => OPTION.exec(l)![2]) : [];
  const rest = runs ? [...lines.slice(0, start), ...lines.slice(end)] : lines;
  const question = rest.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { question, options };
}

/** Whether an entry is an agent's (its author is an agent's name, or "Agent"). */
export function isAgentEntry(author: string): boolean {
  return !!entryAgent(author) || author.trim().toLowerCase() === 'agent';
}

/** Whether an entry is a note of Flotilla's (what happened), not something someone wrote. */
export function isNoteEntry(author: string): boolean {
  return author === 'Flotilla' || !author;
}

/** The agent report that waits for the user: the last report, when nothing was written after it. */
export function pendingReport(activity: StatusEntry[]): StatusEntry | undefined {
  let last = -1;
  for (let i = activity.length - 1; i >= 0; i--) {
    if (isAgentEntry(activity[i].author)) {
      last = i;
      break;
    }
  }
  if (last < 0) return undefined;
  // Anything written after it (a comment, an answer) is the user's: the report isn't waiting anymore.
  if (activity.slice(last + 1).some((e) => !isAgentEntry(e.author) && !isNoteEntry(e.author))) return undefined;
  const lines = activity[last].body.split(/\r?\n/).filter((l) => l.trim());
  return lines.length && WAITING.test(lines[lines.length - 1].trim()) ? activity[last] : undefined;
}

/** How long, in whole minutes, since an ISO time. */
function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** The state in words, with the question an agent asks (if one waits for the user). */
export function ticketStatus(input: StatusInput): TicketStatus {
  const now = input.now ?? Date.now();
  const report = pendingReport(input.activity);
  const waiting = input.agents.find((a) => a.state === 'waiting-for-input');
  if (input.review?.state === 'asking' || report || waiting) {
    const ask = report ? askOf(report.body) : undefined;
    const who = waiting?.agent ?? (report ? entryAgent(report.author) : undefined);
    return {
      tone: 'waiting',
      title: who ? `Waiting for your answer: ${who}` : 'Waiting for your answer',
      // An agent waiting on a prompt in its chat (not a question in the ticket) says what it needs there.
      detail: !ask?.question && waiting?.message ? waiting.message : undefined,
      ...(ask ? { ask } : {}),
    };
  }
  if (input.review?.state === 'yours') return { tone: 'waiting', title: 'Ready for your review' };
  const working = input.agents.find((a) => a.state === 'working');
  if (working) {
    return { tone: 'working', title: `An agent is working: ${working.agent}, ${minutesSince(working.started, now)} min` };
  }
  if (input.review?.running || input.review?.state === 'working' || input.review?.state === 'reviewing' || input.review?.state === 'revising') {
    return { tone: 'working', title: 'An agent is working on it' };
  }
  if (input.status === 'done') return { tone: 'done', title: 'Done' };
  if (input.status === 'todo' && !input.hasWork) return { tone: 'idle', title: 'Not started' };
  return { tone: 'idle', title: input.status === 'review' ? 'In review' : 'Nothing is running' };
}
