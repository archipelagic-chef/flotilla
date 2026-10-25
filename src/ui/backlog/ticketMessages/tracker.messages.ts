/** A ticket tab's messages about its issues in connected trackers: handled in ./tracker.ts. Type-only, as ticketProtocol.ts. */
export type TrackerMessage =
  | { type: 'openRemote' }
  /** Link the item to an issue (asks which), unlink it, or open a linked one. */
  | { type: 'link' }
  | { type: 'unlink'; id: string }
  | { type: 'openLink'; id: string }
  /** Move an issue in its tracker's workflow. */
  | { type: 'transition'; id: string }
  /** Set an issue's priority, by the tracker's name for it. */
  | { type: 'remotePriority'; name: string }
  /** Create an issue for a local item in a connected tracker, and link it. */
  | { type: 'createIssue' };
