/**
 * What tells the actions of a ticket apart while they're in progress. Pure (no DOM, no vscode): the host echoes an
 * action back when it's done, as a copy of the message, so the key must come out the same for the copy.
 */
import type { TicketWebviewMessage } from './ticketProtocol';

/** What tells one action apart from another of its type (a commit, a kind of start, a verdict). */
export function actionKey(m: TicketWebviewMessage): string {
  switch (m.type) {
    case 'openCommit':
      return `openCommit:${m.hash}`;
    case 'start':
      return m.agent ? 'start:agent' : 'start:worktree';
    case 'reviewFix':
      return `reviewFix:${m.fix}`;
    case 'userReview':
      return `userReview:${m.verdict}`;
    case 'postEntry':
      return `postEntry:${m.key}`;
    case 'checkout':
      return `checkout:${m.branch}`;
    case 'run':
      return `run:${m.key}:${m.index}`;
    default:
      return m.type;
  }
}
