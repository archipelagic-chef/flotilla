import * as path from 'node:path';
import type { BacklogItem } from './backlog';
import { entryAgent, sameAgent } from './backlog';
import type { TicketEntry } from './ticket';

/**
 * The review loop: when an item goes to review, a reviewer agent (not the one that did the work) reviews it and gives
 * a verdict in the ticket. Changes requested send it back to the implementer, who reports "Ready for review" when
 * done; the reviewer looks again. It ends when the reviewer approves, or after the most rounds allowed.
 */
export interface ReviewState {
  /** 1 for the first review. */
  round: number;
  /**
   * reviewing: the reviewer is at it; revising: the implementer is making the changes asked for; asking: the
   * implementer asked something and waits for the user's answer (a comment); yours: the work waits for the user's
   * review; approved; stopped: no verdict, too many rounds, or stopped by the user.
   */
  state: 'reviewing' | 'revising' | 'asking' | 'yours' | 'approved' | 'stopped';
  /** The reviewer agent ('' when there has been none yet). */
  reviewer: string;
  /** The user gave the last verdict (approved, or changes requested), not the reviewer agent. */
  byUser?: boolean;
  reviewerSession?: string;
  implementer?: string;
  implementerSession?: string;
  /** The worktree the work (and the review) is in. */
  worktree?: string;
  /** Why it stopped, for the user. */
  reason?: string;
  /** Reports already acted on ("Ready for review", verdicts), by entry key. */
  handled?: string[];
}

export type Verdict = 'approved' | 'changes';

/** A review's verdict, from its last "Verdict: …" line. */
export function parseVerdict(body: string): Verdict | undefined {
  const lines = body.split(/\r?\n/).filter((l) => /^\s*\**\s*verdict\s*\**\s*:/i.test(l));
  const last = lines.at(-1)?.toLowerCase();
  if (!last) return undefined;
  if (/changes?\s+requested|request(ed)?\s+changes|not\s+approved|reject/.test(last)) return 'changes';
  if (/approved?|lgtm|accept/.test(last)) return 'approved';
  return undefined;
}

/** Whether an implementer's report says the work is ready for review (its last line does). */
export function saysReadyForReview(body: string): boolean {
  const last = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return !!last && /^[*_]*ready for review[.!]?[*_]*$/i.test(last);
}

/** Whether an implementer's report asks the user something and waits for the answer (its last line says so). */
export function saysWaitingForUser(body: string): boolean {
  const last = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return !!last && /^[*_]*waiting for (you|the user|your answer)[.!]?[*_]*$/i.test(last);
}

/** The user's comments since the agent's last report (the answer to its question), once: none that were acted on. */
export function userAnswer(entries: TicketEntry[], review: ReviewState, key: (e: TicketEntry) => string): TicketEntry[] {
  const answer: TicketEntry[] = [];
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    if (e.author !== 'You') {
      if (e.author === 'Flotilla') continue;
      break;
    }
    if (review.handled?.includes(key(e))) break;
    answer.unshift(e);
  }
  return answer;
}

/** The user's review as a ticket entry's body: what they wrote, and their verdict. */
export function userReviewBody(verdict: Verdict, text: string): string {
  return [text.trim(), verdict === 'approved' ? 'Verdict: approved' : 'Verdict: changes requested'].filter(Boolean).join('\n\n');
}

/**
 * The newest report by an agent that says it's ready for review and hasn't been acted on, with its index. The
 * reviewer's own reports don't count.
 */
export function readyReport(
  entries: TicketEntry[],
  review: ReviewState | undefined,
  key: (e: TicketEntry) => string,
): { entry: TicketEntry; agent: string } | undefined {
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    const agent = entryAgent(e.author);
    if (!agent || sameAgent(agent, review?.reviewer)) continue;
    if (review?.handled?.includes(key(e))) return undefined;
    if (saysReadyForReview(e.body)) return { entry: e, agent };
  }
  return undefined;
}

/** The reviewer's newest report with a verdict that hasn't been acted on. */
export function verdictReport(
  entries: TicketEntry[],
  review: ReviewState,
  key: (e: TicketEntry) => string,
): { entry: TicketEntry; verdict: Verdict } | undefined {
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    if (!sameAgent(entryAgent(e.author), review.reviewer)) continue;
    if (review.handled?.includes(key(e))) return undefined;
    const verdict = parseVerdict(e.body);
    if (verdict) return { entry: e, verdict };
  }
  return undefined;
}

/**
 * How a report that hands work over for review says what to look at: in order, with links to the files (which the
 * ticket opens at their lines), and pictures where they explain better (files next to the ticket, which it shows).
 */
export function reviewNotes(o: { id: string; backlogDir: string }): string {
  const folder = `${o.backlogDir}/${o.id}`;
  return `That report says how to review the work, under a heading "#### How to review": what to look at, in the order to look at it (the files and lines that matter, what changed there and why), how to try it, and what's risky or still open. Link every file you mention by its path from the repository root, with the lines: [src/api/limit.ts:42](src/api/limit.ts#L42), or #L42-L60 for a range; the ticket opens them. Where a picture explains it better than words (a flow, a structure, before and after, a screenshot), add one: save it as an SVG (or PNG) file in ${folder}/ and show it with ![What it shows](${o.id}/name.svg).`;
}

/** What the reviewer is told. Its first line names it and the item (that's how the ticket finds its chat). */
export function reviewerPrompt(o: {
  item: Pick<BacklogItem, 'id' | 'title'>;
  reviewer: string;
  implementer?: string;
  ticket: string;
  branch: string;
  base: string;
  round: number;
}): string {
  const who = o.implementer ? `${o.implementer} (another agent)` : 'another agent';
  return [
    `You are agent ${o.reviewer}, working on backlog item ${o.item.id}: "${o.item.title}". You are its reviewer.`,
    o.round === 1
      ? `${who} did the work, in this git worktree on branch ${o.branch}. Review it: read the ticket ${o.ticket} (the description and its acceptance criteria, then the activity, starting from the "How to review" notes in its last report), the changes (git diff ${o.base}...HEAD, and the commit messages), and run the tests.`
      : `Round ${o.round}: ${who} made changes after your last review (see the ticket ${o.ticket}). Review again: check that what you asked for was done, and look at the new changes (git diff ${o.base}...HEAD).`,
    `Don't change the code: only review. Report in the ticket: append an entry at the end of its "## Activity" section, a heading "### YYYY-MM-DD HH:MM · Agent ${o.reviewer}" (local time) followed by your review in Markdown: what's good, and what must change, as a checklist, specific enough to act on.`,
    `End the entry with a line saying your verdict, exactly "Verdict: approved" or "Verdict: changes requested". Approve when it's good enough to merge: it does what the ticket asks, it's tested, and nothing important is wrong. Don't hold it up for matters of taste; mention those without requesting them.`,
    `Never change issue trackers (Jira, GitHub Issues), and don't push.`,
  ].join('\n\n');
}

/** What the implementer is told when the reviewer asks for changes (its chat resumed). */
export function revisionPrompt(o: { item: Pick<BacklogItem, 'id'>; reviewer: string; ticket: string; round: number }): string {
  return [
    `${o.reviewer}, an agent reviewing ${o.item.id}, requested changes (review round ${o.round}). Read its review at the end of the ticket ${o.ticket}.`,
    MAY_ASK,
    `Make the changes, commit them (messages start with "${o.item.id}: "), then report in the ticket as before, saying what you changed for each request. End that report with a line "Ready for review." so it's reviewed again.`,
    reviewNotes({ id: o.item.id, backlogDir: path.dirname(o.ticket) }),
    `If you disagree with a request, say why in your report instead of making the change.`,
  ].join('\n\n');
}

/** The ticket's description stays what's to be done: the implementer works the user's requests into it. */
const UPDATE_DESCRIPTION = (ticket: string) =>
  `Keep the ticket's description what's to be done: as you take up what the user asks (here, and in their answers), work it into the description in ${ticket} (between the "# Title" and "## Activity"), usually as acceptance criteria. Edit only the description there, and leave the activity as it is.`;

/** How the implementer may ask the user before (or instead of) making changes, when it needs to. */
const MAY_ASK = `If you need more context to do it well (what's asked is unclear, or there's a choice only the user can make), ask first: report in the ticket with your questions, end the report with a line "Waiting for you.", and stop without changing anything. You're resumed with the answer. Otherwise start on it directly.`;

/** What the implementer is told when the user reviewed the work and requested changes. */
export function userRevisionPrompt(o: { item: Pick<BacklogItem, 'id'>; ticket: string; feedback: string }): string {
  const feedback = o.feedback.trim();
  return [
    `The user reviewed your work on ${o.item.id} and requested changes${feedback ? ':' : ', without saying more (their review is at the end of the ticket ' + o.ticket + ').'}`,
    ...(feedback ? [feedback.replace(/^/gm, '> ')] : []),
    `Read the ticket ${o.ticket} for the context (the description, and the activity).`,
    MAY_ASK,
    UPDATE_DESCRIPTION(o.ticket),
    `Make the changes, commit them (messages start with "${o.item.id}: "), then report in the ticket, saying what you changed for each request. End that report with a line "Ready for review." so the user reviews it again. If you disagree with a request, say why in your report instead of making the change.`,
    reviewNotes({ id: o.item.id, backlogDir: path.dirname(o.ticket) }),
  ].join('\n\n');
}

/** What the implementer is told when the user answered its question (its chat resumed). */
export function answerPrompt(o: { item: Pick<BacklogItem, 'id'>; ticket: string; answer: string }): string {
  return [
    `The user answered you in the ticket ${o.ticket}:`,
    o.answer.trim().replace(/^/gm, '> '),
    UPDATE_DESCRIPTION(o.ticket),
    `Go on with the changes for ${o.item.id}. Commit them (messages start with "${o.item.id}: "), then report in the ticket, ending with a line "Ready for review." If you still need to know more, ask again the same way (end the report with "Waiting for you.").`,
    reviewNotes({ id: o.item.id, backlogDir: path.dirname(o.ticket) }),
  ].join('\n\n');
}
