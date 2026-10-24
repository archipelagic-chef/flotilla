/** A ticket tab's messages about merging it, and cleaning up its branch's history first: handled in ./merge.ts. Type-only, as ticketProtocol.ts. */
export type MergeMessage =
  /** Fix with Agent on the red CI Merge to main stopped on (BL-112). */
  | { type: 'mergeCiFix' }
  /** Clean up the history of its branch; and the clean-up's actions. */
  | { type: 'cleanUp' }
  | { type: 'finishCleanUp' }
  | { type: 'cancelCleanUp' }
  | { type: 'compareCleanUp' }
  /** Merge it into the base branch; a merge's decisions; push the base branch after. */
  | { type: 'merge' }
  | { type: 'mergeResolve' }
  | { type: 'mergeApprove' }
  | { type: 'mergeRecheck' }
  | { type: 'mergeCancel' }
  /** Stop waiting for CI to pass (BL-105): nothing is merged. */
  | { type: 'mergeCiCancel' }
  /** A merge's checks (BL-169): Stop them; the whole log of a run (Show All); the log, followed, in a terminal. */
  | { type: 'mergeChecksStop' }
  | { type: 'mergeChecksLog'; requestId: number; log: string }
  | { type: 'mergeChecksTerminal'; log: string }
  | { type: 'mergeQueueRemove' }
  /** Resolve its conflicts with the tickets ahead of it in the merge train, in its merge there (BL-146). */
  | { type: 'mergeQueueResolve' }
  /** Merge Next (BL-144): to the front of the merge queue. */
  | { type: 'mergeNext' }
  | { type: 'push' }
  /** Done with unmerged work: a sibling ticket to merge a branch (asks which, unless given); or dismiss the warning. */
  | { type: 'mergeSibling'; branch?: string }
  | { type: 'dismissUnmerged' };
