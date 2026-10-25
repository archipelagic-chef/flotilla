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
  /** Expand: the sidebar's Version Control on the ticket's Changes (BL-171), that file selected. */
  | { type: 'expandChange'; group: number; path: string }
  /** A file's diff, to show inline (answered with changeDiff). */
  | { type: 'readChangeDiff'; requestId: number; group: number; path: string }
  | { type: 'openAllChanges' }
  /** Create a worktree for a branch of the item that has none. */
  | { type: 'checkout'; branch: string }
  /** Remove a worktree of the ticket (asks first, as Remove Worktree… does). */
  | { type: 'removeWorktree'; key: string }
  /** Run a run block of an agent's report (after asking): the Run buttons. */
  /** try: a demo block's window set up as the demo starts, its steps not played (Try it yourself, BL-135). */
  | { type: 'run'; key: string; index: number; try?: boolean };
