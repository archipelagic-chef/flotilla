import type { BacklogItem } from './backlog';
import type { ReviewState } from './review';

/**
 * Whose turn a ticket in review is: the user's (to review it, or approve or merge what a reviewer agent approved), a
 * reviewer agent's, the implementer's (making the changes asked for), the user's to answer a question, or the user's
 * to decide how a stopped review goes on. The cards, the ticket's header and "Needs you" all read it, so they agree.
 * Shared by the host and the webviews (no node or vscode APIs).
 */
export type TurnKind = 'yours' | 'agent-review' | 'agent-revising' | 'asking' | 'stopped' | 'paused';

export interface Turn {
  kind: TurnKind;
  /** Whose turn: "You", or the agent's name ("Agent" when it isn't known yet). */
  who: string;
  /** It waits on the user. */
  mine: boolean;
}

/** The turn in a few words, as the cards and the filter name it. */
export const TURN_LABEL: Record<TurnKind, string> = {
  yours: 'Your review',
  'agent-review': 'Agent review',
  'agent-revising': 'Agent revising',
  asking: 'Waiting for you',
  stopped: 'Stopped',
  paused: 'Paused',
};

/** The codicon for each turn. */
export const TURN_ICON: Record<TurnKind, string> = {
  yours: 'account',
  'agent-review': 'eye',
  'agent-revising': 'tools',
  asking: 'question',
  stopped: 'debug-pause',
  paused: 'debug-pause',
};

const you = (kind: TurnKind): Turn => ({ kind, who: 'You', mine: true });
const agent = (kind: TurnKind, name: string | undefined): Turn => ({ kind, who: name || 'Agent', mine: false });

/**
 * The turn of an item in review, or none: done items, proposals, and work that hasn't been to review yet (an agent at
 * its first go, a todo) have none. An item moves to In Progress while its implementer revises; that's still its review.
 */
export function turnOf(item: Pick<BacklogItem, 'status' | 'proposed' | 'review'>): Turn | undefined {
  if (item.status === 'done' || item.proposed) return undefined;
  const r = item.review;
  const inReview = item.status === 'review';
  switch (r?.state) {
    case 'yours':
    case 'approved':
      return you('yours');
    case 'asking':
      return you('asking');
    case 'stopped':
      return you('stopped');
    case 'reviewing':
      return agent('agent-review', r.reviewer);
    case 'revising':
      // In review, a revision that reported "Ready for review" waits for its reviewer to start.
      if (inReview) return agent('agent-review', r.reviewer);
      return r.round > 0 ? agent('agent-revising', r.implementer) : undefined;
    case 'paused':
      // Paused by the user, it waits for them to resume it.
      if (r.paused?.byUser) return you('paused');
      // On Claude's usage limit, the agent goes on by itself: still its turn.
      if (r.paused?.phase === 'review') return agent('agent-review', r.paused.agent || r.reviewer);
      return r.round > 0 || inReview ? agent('agent-revising', r.paused?.agent ?? r.implementer) : undefined;
    case 'working':
    case undefined:
      // In review with no reviewer agent at it: it's the user's to review.
      return inReview ? you('yours') : undefined;
  }
}

/** The ticket's header for a turn: whose turn, with the reviewer and the implementer named, and what the user can do now. */
export function turnSentence(turn: Turn, r: ReviewState | undefined): { text: string; todo: string } {
  const work = r?.implementer ? `${r.implementer}'s work` : 'the work';
  const round = r && r.round > 0 ? `, round ${r.round}` : '';
  switch (turn.kind) {
    case 'agent-review':
      return {
        text: r?.reviewer ? `${r.reviewer} reviews ${work}${round}.` : `A reviewer agent is about to review ${work}.`,
        todo: 'Wait for its verdict, or stop the review and review it yourself.',
      };
    case 'agent-revising':
      return {
        text: `${turn.who} makes the changes ${r?.byUser ? 'you' : r?.reviewer || 'the reviewer'} asked for${round}.`,
        todo: 'It reports "Ready for review" when done. You can stop it.',
      };
    case 'asking':
      return {
        text: `${r?.implementer ?? 'The agent'} asks you something about ${r?.implementer ? 'its work' : 'the work'}${round}.`,
        todo: 'Answer it in its report or in a comment below; it goes on from there.',
      };
    case 'paused':
      return { text: `You paused ${r?.paused?.agent ?? 'its agent'}${round}.`, todo: 'Resume it: it goes on in the same chat, where it left off.' };
    case 'stopped':
      if (r?.stop?.kind === 'user' && r.stop.agent)
        return { text: `You stopped ${r.stop.agent.agent}${round}.`, todo: 'Resume it in its chat, or hand the work to a new agent.' };
      return r?.stop?.kind === 'user'
        ? { text: `You stopped the review of ${work}${round}.`, todo: 'Review it yourself, or start the review again.' }
        : { text: `The review of ${work} stopped${round}: ${r?.reason ?? 'no verdict.'}`, todo: 'Choose how it goes on.' };
    case 'yours':
      if (r?.state === 'approved') {
        return r.byUser
          ? { text: `You approved ${work}${round}.`, todo: 'Merge it, then move it to Done.' }
          : {
              text: `${r.reviewer || 'The reviewer'} approved ${work}${round}. It waits for your approval.`,
              todo: 'Approve it and merge it, or request changes.',
            };
      }
      return {
        text: `${r?.implementer ? work : 'The work'} waits for your review${round}.`,
        todo: 'Approve it, or write what should change below and request changes.',
      };
  }
}
