/** A ticket tab's messages about opening its files, worktrees, commits and links, and running run blocks: handled in ./files.ts. Type-only, as ticketProtocol.ts. */
export type FilesMessage =
  | { type: 'openFile' }
  | { type: 'openWorktree'; key: string }
  /** A link in a description or an entry: a file in the repository (path#L10-L20), or a web page. */
  | { type: 'openHref'; href: string }
  /** Open what a commit changed. */
  | { type: 'openCommit'; hash: string }
  /** A file of its Changes in the diff editor (group: its index; line: on its right side, else its left), or all of them in the multi-file diff editor. */
  | { type: 'openChange'; group: number; path: string; line?: number }
  /** Expand (BL-171): the sidebar's Version Control on the ticket's Changes, that file selected (the tab shows its diff). */
  | { type: 'expandChange'; group: number; path: string }
  /** A file's diff, to show inline, or (whole) all of the file for the full view (answered with changeDiff). */
  /** Open in Version Control (BL-173): the section's (no path), or a file's of a group (see vcTarget). */
  | { type: 'openInVc'; group?: number; path?: string }
  | { type: 'readChangeDiff'; requestId: number; group: number; path: string; whole?: boolean }
  /** Open All Changes: those the path filter leaves (filter, BL-174), else all. */
  | { type: 'openAllChanges'; filter?: string }
  /** Narrow its Changes to some of its commits (BL-174); none: all of its change again. */
  | { type: 'narrowChanges'; commits: string[] }
  /** Create a worktree for a branch of the item that has none. */
  | { type: 'checkout'; branch: string }
  /** Remove a worktree of the ticket (asks first, as Remove Worktree… does). */
  | { type: 'removeWorktree'; key: string }
  /** Run a run block of an agent's report (after asking): the Run buttons. */
  /** try: a demo block's window set up as the demo starts, its steps not played (Try it yourself, BL-135). */
  | { type: 'run'; key: string; index: number; try?: boolean };
