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
   * reviewing: the reviewer is at it; revising: the implementer is making the changes asked for; approved; stopped:
   * no verdict, too many rounds, or stopped by the user.
   */
  state: 'reviewing' | 'revising' | 'approved' | 'stopped';
  reviewer: string;
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

/**
 * The newest report by an agent that says it's ready for review and hasn't been acted on, with its index. The
 * reviewer's own reports don't count.
 */
export function readyReport(entries: TicketEntry[], review: ReviewState | undefined, key: (e: TicketEntry) => string): { entry: TicketEntry; agent: string } | undefined {
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
export function verdictReport(entries: TicketEntry[], review: ReviewState, key: (e: TicketEntry) => string): { entry: TicketEntry; verdict: Verdict } | undefined {
  for (let n = entries.length - 1; n >= 0; n--) {
    const e = entries[n];
    if (!sameAgent(entryAgent(e.author), review.reviewer)) continue;
    if (review.handled?.includes(key(e))) return undefined;
    const verdict = parseVerdict(e.body);
    if (verdict) return { entry: e, verdict };
  }
  return undefined;
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
      ? `${who} did the work, in this git worktree on branch ${o.branch}. Review it: read the ticket ${o.ticket} (the description and its acceptance criteria, then the activity), the changes (git diff ${o.base}...HEAD, and the commit messages), and run the tests.`
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
    `Make the changes, commit them (messages start with "${o.item.id}: "), then report in the ticket as before, saying what you changed for each request. End that report with a line "Ready for review." so it's reviewed again.`,
    `If you disagree with a request, say why in your report instead of making the change.`,
  ].join('\n\n');
}
