import { entryAgent } from './backlog';
import { parseVerdict, saysReadyForReview, saysWaitingForUser, type ReviewState, type Verdict } from './review';

/**
 * Folding a review's rounds in a ticket's activity. A review is agents talking to each other: the reviewer's verdicts,
 * the implementer's changes and "Ready for review" reports, and Flotilla's notes about the rounds. In the feed, one
 * review (from the round that opens it to its approval) shows as one line, "Reviewed by Flux-3 in 2 rounds →
 * approved", which opens to the entries and commits in order. Anything from people (their comments, reviews and
 * answers), questions to the user and stopped reviews stay as they are.
 */

/**
 * How a feed item takes part in a review: stays as it is (and ends a fold); is part of a review's rounds; opens a
 * review (its first round, or a round after the user's review); or approves, which ends the review.
 */
export type RoundPart = 'stay' | 'round' | 'open' | 'close';

export interface RoundInfo {
  part: RoundPart;
  /** The verdict a reviewer's report gives. */
  verdict?: Verdict;
  /** The agent that wrote a verdict. */
  agent?: string;
  /** The reviewer a round's first note names ("opened a chat for agent Flux-3"). */
  reviewer?: string;
  /** The round a Flotilla note is about ("Review round 2: …"). */
  round?: number;
}

/** A ticket entry's part in a review (a commit is "round": see the feed). */
export function entryRound(e: { author: string; body: string }): RoundInfo {
  if (e.author === 'Flotilla') {
    const round = /^Review round (\d+):/.exec(e.body);
    if (round) {
      const started = /^Review round \d+: (?:opened|resumed) a chat for agent ([A-Za-z0-9-]+)/.exec(e.body);
      return { part: 'open', round: Number(round[1]), ...(started ? { reviewer: started[1] } : {}) };
    }
    // An agent stopped on a usage limit, and went on: part of its round.
    return { part: /^The limit reset:|stopped on Claude/.test(e.body) ? 'round' : 'stay' };
  }
  const agent = entryAgent(e.author);
  // Not an agent's report (a person's comment or review), or an agent asking the user: visible.
  if (!agent || saysWaitingForUser(e.body)) return { part: 'stay' };
  const verdict = parseVerdict(e.body);
  if (verdict) return { part: verdict === 'approved' ? 'close' : 'round', verdict, agent };
  return { part: saysReadyForReview(e.body) ? 'open' : 'round' };
}

export interface RoundFold<T> {
  /** Who reviewed it (the agent that wrote its first verdict, or the one its first round named). */
  reviewer?: string;
  /** The rounds it went through: at least one. */
  rounds: number;
  /** How it stands: "approved", "changes requested", "round 3 running"… */
  outcome: string;
  /** Its entries and commits, in order. */
  items: T[];
}

export type FeedGroup<T> = { item: T } | { fold: RoundFold<T> };

/** The review the ticket is in now, when the last of the feed is part of it. */
export interface CurrentReview {
  state: ReviewState['state'];
  reviewer?: string;
}

/**
 * The feed (entries and commits, in order) with each review folded into one group. A review opens at an "open" item
 * and runs to its approval, or to the next item that stays; items before it, and after its approval, stay.
 */
export function foldRounds<T>(feed: T[], info: (item: T) => RoundInfo, current?: CurrentReview): Array<FeedGroup<T>> {
  const parts = feed.map(info);
  const groups: Array<FeedGroup<T>> = [];
  let i = 0;
  while (i < feed.length) {
    if (parts[i].part !== 'open') {
      groups.push({ item: feed[i] });
      i++;
      continue;
    }
    let end = i;
    while (parts[end].part !== 'close' && end + 1 < feed.length && parts[end + 1].part !== 'stay') end++;
    const trailing = end === feed.length - 1 ? current : undefined;
    groups.push({ fold: makeFold(feed.slice(i, end + 1), parts.slice(i, end + 1), trailing) });
    i = end + 1;
  }
  return groups;
}

function makeFold<T>(items: T[], parts: RoundInfo[], current?: CurrentReview): RoundFold<T> {
  const verdicts = parts.filter((p) => p.verdict);
  const last = verdicts.at(-1)?.verdict;
  const reviewer = verdicts[0]?.agent ?? parts.find((p) => p.reviewer)?.reviewer ?? (current?.reviewer || undefined);
  // The round a running review is in: the newest one its notes name (a review split by a comment starts at its number).
  const running = Math.max(verdicts.length + 1, ...parts.map((p) => p.round ?? 0));
  let outcome: string;
  if (last === 'approved') outcome = 'approved';
  else if (!current) outcome = last === 'changes' ? 'changes requested' : 'no verdict';
  else if (current.state === 'reviewing') outcome = `${last === 'changes' ? 'changes requested, ' : ''}round ${running} running`;
  else outcome = reviewOutcome(current.state);
  return { ...(reviewer ? { reviewer } : {}), rounds: Math.max(1, verdicts.length), outcome, items };
}

/** A review's state in a few words: the card at the top of a ticket, and a folded review's line, say it this way. */
export function reviewOutcome(state: ReviewState['state']): string {
  switch (state) {
    case 'working':
      return 'in progress';
    case 'reviewing':
      return 'in review';
    case 'revising':
      return 'changes requested';
    case 'asking':
      return 'has a question';
    case 'yours':
      return 'waiting for you';
    case 'approved':
      return 'approved';
    case 'stopped':
      return 'stopped';
    case 'paused':
      return 'paused';
  }
}
