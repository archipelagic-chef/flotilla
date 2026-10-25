/** A ticket tab's messages about discussing and reviewing it, and updating its branch from main: handled in ./review.ts. Type-only, as ticketProtocol.ts. */
import type { ReviewFix } from '../../../features/backlog/review';

export type ReviewMessage =
  /** Discuss the ticket with an agent (BL-45), without a comment first; Keep discussing dismisses "ready to start". */
  | { type: 'discuss' }
  | { type: 'keepDiscussing' }
  /** Accept or dismiss an agent's proposal; open another ticket (a parent, a sub-ticket). */
  | { type: 'startReview' }
  /** The user's own review: approve, or request changes (an agent picks them up). */
  | { type: 'userReview'; verdict: 'approved' | 'changes'; text: string }
  | { type: 'stopReview' }
  /** Rebase its branch onto main, or have its agent do it when that conflicts (BL-55, BL-181). */
  | { type: 'updateFromMain' }
  /** Fix a stopped review: go on, hand it to a new agent, give it in the implementer's chat… */
  | { type: 'reviewFix'; fix: ReviewFix }
  /** The queued start of this ticket: start it now (see ReviewLoop.prioritize). */
  | { type: 'prioritize' };
