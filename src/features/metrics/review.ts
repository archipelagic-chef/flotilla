import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  schedulesDir,
  taskDir,
} from '../schedules/schedule';

/**
 * The improvement review (BL-159): an agent reads the metrics' summary and the code, and writes a short report of the
 * biggest problems in how the work flows, with a proposed ticket for each one worth fixing. It's a scheduled task
 * (BL-263), schedules/improvement-review.md, run by the Scheduler like any other; what's its own is what it's given
 * (its context: metrics, reviewContext). Its reports were kept in the backlog's `reviews/` folder before.
 */
export const REVIEW_TASK = 'improvement-review';
/** Where its reports were kept before it was a scheduled task (BL-159): moved to the task's folder. */
export const REVIEWS_DIR = 'reviews';
/** The context: its file names, for what Flotilla adds to its prompt. */
export const REVIEW_CONTEXT = 'metrics';

/** A review's title: its first heading, else "Improvement review <day>". */
export function reviewTitle(text: string, day: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1].trim() || `Improvement review ${day}`;
}

/**
 * The task's file as Flotilla first writes it: every `every` days (flotilla.metrics.reviewEvery, deprecated), paused when
 * that's 0. The instructions are the review's (BL-159); the scheduled task's prompt adds where to write and how to propose.
 */
export function reviewTaskFile(every: number): string {
  const days = Math.max(1, Math.round(every));
  return [
    '---',
    'title: Improvement review',
    `every: ${days === 1 ? 'day' : `${days} days`}`,
    'when: idle',
    `context: ${REVIEW_CONTEXT}`,
    ...(every > 0 ? [] : ['paused: true']),
    '---',
    "Find the three to five biggest problems in how Flotilla's work flows, each with its numbers and its likely cause in",
    'the code, and propose a ticket for each one worth fixing. Flotilla records what happens as events; their summary, the',
    'merged fixes and the open tickets follow these instructions.',
    '',
    'Check a number before you build on it: grep the events for a kind or a ticket rather than reading whole files.',
    "Don't propose what an open ticket already covers: name it in your report instead (and say what its numbers are).",
    '',
    'Your report, after its summary:',
    '- "## Fixes checked": each merged fix listed below, whether it helped, by how much (or "No fixes to check yet.").',
    '- "## Problems": three to five, biggest first, each "### <n>. <the problem in a few words>" with **Numbers** (the',
    '  metric ids and values, this period and before), **Evidence** (the events, tickets as their ids, and code as links',
    '  with lines), **Likely cause**, and **Proposal** (the ticket you propose, by its title, or the open ticket that',
    '  covers it, by its id).',
    '- "## The numbers": the table below, as it is.',
    '',
    'Each proposal has, after its **Why:**, a line "Improves: <metric id> from <its value now> to <the target>", naming',
    'exactly one metric id from the table: the next review checks it. Propose only what the numbers back.',
    '',
  ].join('\n');
}

export interface ReviewContextInput {
  /** The metrics' summary (summaryMarkdown) and the merged fixes' before and after (fixesMarkdown). */
  summary: string;
  fixes: string;
  /** The open tickets: id, status and title, one a line. */
  openTickets: string[];
  eventsDir: string;
}

/** What the review's agent is given besides its instructions (context: metrics): the numbers, the fixes, the open tickets, the events. */
export function reviewContext(o: ReviewContextInput): string {
  return [
    `## The numbers\n\n${o.summary}`,
    `## Fixes merged with an Improves: line, before and after\n\nEach row is a ticket proposed to move a metric: its metric over the four weeks before it landed, and since. Say in your report whether each helped.\n\n${o.fixes}`,
    `## Open tickets\n\n${o.openTickets.length ? o.openTickets.join('\n') : '(none)'}`,
    `## The events\n\nThe raw events are at ${o.eventsDir} (events-YYYY-MM.jsonl: one JSON object a line, {at, kind, ticket?, agent?, data, imported?}; "imported" ones were read in from the history, not seen as they happened). You can read them, not change them.`,
  ].join('\n\n');
}

/**
 * Moves the reviews written before (reviews/YYYY-MM-DD.md, BL-159) into the task's folder, so they're its reports. One
 * whose day the folder has already is kept where it is (none is lost); the folder goes once it's empty. The days moved.
 */
export async function moveReviews(backlogDir: string): Promise<string[]> {
  const from = path.join(backlogDir, REVIEWS_DIR);
  const names = await fs.promises.readdir(from).catch(() => undefined);
  if (!names) return [];
  const to = taskDir(backlogDir, REVIEW_TASK);
  await fs.promises.mkdir(to, { recursive: true });
  const moved: string[] = [];
  for (const n of names) {
    if (fs.existsSync(path.join(to, n))) continue;
    await fs.promises.rename(path.join(from, n), path.join(to, n)).then(
      () => /^\d{4}-\d{2}-\d{2}\.md$/.test(n) && moved.push(n.slice(0, -3)),
      () => undefined,
    );
  }
  await fs.promises.rmdir(from).catch(() => undefined);
  return moved.sort();
}

/** Writes the task's file when there's none (its first start as a scheduled task); whether it wrote it. */
export async function writeReviewTask(backlogDir: string, every: number): Promise<boolean> {
  const file = path.join(schedulesDir(backlogDir), `${REVIEW_TASK}.md`);
  await fs.promises.mkdir(schedulesDir(backlogDir), { recursive: true });
  return fs.promises.writeFile(file, reviewTaskFile(every), { flag: 'wx' }).then(
    () => true,
    () => false,
  );
}
