import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The improvement review (BL-159): an agent reads the metrics' summary and the code, and writes a short report of the
 * biggest problems in how the work flows, with a proposed ticket for each one worth fixing. Its reports are kept in
 * the backlog's `reviews/` folder, one a day at most (`YYYY-MM-DD.md`).
 */
export const REVIEWS_DIR = 'reviews';

const DAY_MS = 86_400_000;

export function reviewsDir(backlogDir: string): string {
  return path.join(backlogDir, REVIEWS_DIR);
}

/** A day's local date, as the review's name. */
export function reviewDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** The reviews written, newest first, as their days. */
export async function listReviews(backlogDir: string): Promise<string[]> {
  const names = await fs.promises.readdir(reviewsDir(backlogDir)).catch(() => [] as string[]);
  return names
    .flatMap((n) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n)?.[1] ?? [])
    .sort()
    .reverse();
}

/** Whether a review is due: `every` days since the last one (none yet: due), never when `every` is 0. */
export function reviewDue(o: { last?: string; every: number; now: Date }): boolean {
  if (!(o.every > 0)) return false;
  if (!o.last) return true;
  const last = new Date(`${o.last}T00:00:00`).getTime();
  return o.now.getTime() - last >= o.every * DAY_MS - DAY_MS / 2;
}

/** What keeps a review from starting now; undefined when it may. */
export function reviewBlocked(v: { running: number; waiting: number; waitingUntil?: string; pausedAll?: number; enabled: boolean; idle?: string; elsewhere: boolean }): string | undefined {
  if (v.elsewhere) return 'another window runs the autopilot';
  if (v.pausedAll) return 'all agents are paused';
  if (v.waitingUntil) return 'agents wait for a usage limit';
  if (v.running) return `${v.running === 1 ? 'an agent is' : `${v.running} agents are`} working`;
  if (v.waiting) return 'starts are waiting for a slot';
  if (v.enabled && !v.idle) return 'the autopilot has tickets to start';
  return undefined;
}

/** The only tools the review's agent has: reading anything, and writing its review and its proposals. */
export function reviewTools(o: { reviewFile: string; inboxDir: string }): string[] {
  const abs = (p: string) => `//${p.replace(/^\/+/, '')}`;
  return ['Read', 'Grep', 'Glob', `Write(${abs(o.reviewFile)})`, `Write(${abs(o.inboxDir)}/review-*.md)`];
}

export interface ReviewPromptInput {
  agent: string;
  day: string;
  /** The metrics' summary (summaryMarkdown) and the merged fixes' before and after (fixesMarkdown). */
  summary: string;
  fixes: string;
  /** The open tickets: id, status and title, one a line. */
  openTickets: string[];
  reviewFile: string;
  inboxDir: string;
  eventsDir: string;
  mainRoot: string;
  backlogDir: string;
  /** The last review's file, to see what it proposed. */
  lastReview?: string;
}

/** The review's prompt: what it's given, what it digs in, and what it writes where. */
export function reviewPrompt(o: ReviewPromptInput): string {
  return [
    `You are agent ${o.agent}, writing Flotilla's improvement review of ${o.day}. Flotilla runs coding agents on a backlog of tickets; it records what happens as events. Your job: find the three to five biggest problems in how the work flows, each with its numbers and its likely cause in the code, and propose a ticket for each one worth fixing.`,
    `## The numbers\n\n${o.summary}`,
    `## Fixes merged with an Improves: line, before and after\n\nEach row is a ticket proposed to move a metric: its metric over the four weeks before it landed, and since. Say in your review whether each helped.\n\n${o.fixes}`,
    `## Open tickets\n\nDon't propose what one of these already covers: name it in your review instead (and say what its numbers are).\n\n${o.openTickets.length ? o.openTickets.join('\n') : '(none)'}`,
    [
      `## Digging in`,
      `You can read, not change: the repository at ${o.mainRoot}, the backlog at ${o.backlogDir} (backlog.json, and each ticket's <id>.md with its activity), and the raw events at ${o.eventsDir} (events-YYYY-MM.jsonl: one JSON object a line, {at, kind, ticket?, agent?, data, imported?}; "imported" ones were read in from the history, not seen as they happened). Grep the events for a kind or a ticket rather than reading whole files. Check a number before you build on it.${o.lastReview ? ` The last review is ${o.lastReview}.` : ''}`,
    ].join('\n\n'),
    [
      `## What you write`,
      `1. The review, with the Write tool, to ${o.reviewFile} (you may write no other file but the proposals). In Markdown:`,
      [
        `   - "# Improvement review ${o.day}", then a summary of at most three lines.`,
        `   - "## Fixes checked": each merged fix above, whether it helped, by how much (or "No fixes to check yet.").`,
        `   - "## Problems": three to five, biggest first, each "### <n>. <the problem in a few words>" with **Numbers** (the metric ids and values, this period and before), **Evidence** (the events, tickets as their ids, and code as links from the repository root with lines, like [src/a.ts:42](src/a.ts#L42)), **Likely cause**, and **Proposal** (the ticket you propose, by its title, or the open ticket that covers it, by its id).`,
        `   - "## The numbers": the table above, as it is.`,
      ].join('\n'),
      `2. Each proposal, with the Write tool, as a file ${o.inboxDir}/review-${o.day}-<n>.md (n = the problem's number), which Flotilla turns into a proposed ticket for the user to accept or dismiss:`,
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
        '   **Why:** the numbers, and the cause you found.',
        '',
        '   Improves: <metric id> from <its value now> to <the target>',
        '',
        '   Acceptance criteria:',
        '   - [ ] ...',
        '   ```',
      ].join('\n'),
      `   The Improves: line names exactly one metric id from the table, with its value now and the target: the next review checks it. Propose only what the numbers back, and nothing an open ticket covers.`,
      `3. Your final message: the review's summary (at most three lines), nothing else.`,
    ].join('\n'),
  ].join('\n\n');
}
