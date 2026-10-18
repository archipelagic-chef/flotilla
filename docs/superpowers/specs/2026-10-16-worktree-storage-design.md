# Worktree storage: remove finished worktrees, share big folders

## Problem

On 2026-10-16 this repository took 13 GB on disk: 11 GB in `.worktrees/` (45 worktrees, ~250 MB each), 2.1 GB in
`.vscode-test/` (downloaded VS Code builds), and only 11 MB in `.git`. Two things cause it:

1. **Worktrees are never removed.** Only the user's Remove command ([commands.ts](../../../src/ui/commands.ts),
   `removeWorkstream`) removes one. 41 of the 45 belonged to tickets that were Done, all without uncommitted changes.
2. **Every worktree has its own full `node_modules`** (~180 MB), installed by `flotilla.setupCommand` or by the agent.

Flotilla should keep this from happening, without the user deleting things by hand. `.vscode-test/` is a test-runner
cache and out of scope.

## Part 1: Remove a worktree once its ticket is done

### When

- A backlog change that moves a ticket to Done (the backlog watcher, `LocalBacklog.watch`).
- A periodic sweep, like the git packing check (`PACKING_CHECK_MS`), for changes missed while no window was open.

Only the leading window acts (`backlog/leader.ts`), so two windows never remove the same worktree.

### Safe to remove

A pure function, `removalDecision(input) → 'remove' | { ask: reason } | 'skip'`, in `src/features/storage/`:

| Condition | Not met → |
|---|---|
| Ticket status is `done` and the ticket isn't proposed | skip (review, doing and todo are never touched) |
| Worktree isn't the main one, and is reachable from this environment | skip |
| No uncommitted or untracked changes (`removalRisks().changedFiles === 0`) | ask: "N uncommitted or untracked files" |
| No agent `working` or `waiting-for-input` in it | ask: "an agent is still running in it" |
| No window has it open, or used it recently (attention isn't `active`) | ask: "it's open in a window" |
| The user didn't choose Keep for this ticket before | skip |

The branch's merge state isn't a condition: the branch is always kept, so unmerged work stays.

### How

- Before removal, links and junctions at the worktree's top level are deleted as links (`fs.unlink`, or `rmdir` for a
  Windows junction), never followed. BL-6's worktree had `node_modules.bl6` pointing at the main `node_modules`.
- Removal is the existing `WorktreeService.remove(wt, { force: false })`: retarget the back-pointer, unlock,
  `git worktree remove`. A failure re-locks, as today, and is reported as "couldn't remove: <git error>".
- The ticket's activity gets one line: "Worktree removed (branch kept): 248 MB freed". The size counts only files with
  `nlink === 1`, so files shared with another worktree (part 2) aren't counted as freed. It's measured before removal,
  and skipped (no size in the line) if measuring takes longer than a few seconds.
- **Ask** is a notification: "BL-12's worktree wasn't removed: an agent is still running in it." with buttons
  **Remove anyway** (the existing Remove flow, including its confirmation when files would be lost) and **Keep**. Keep
  is stored per ticket in workspace state and not asked again. It's asked once per ticket, not on every sweep.

### First run

The first sweep after this ships doesn't remove anything on its own. It asks once: "41 finished worktrees take 10 GB.
Remove them? (Branches are kept.)" with **Remove** / **Not now** / **Never**. **Never** sets the setting to `off`.
After the answer, removal is automatic.

### Setting

`flotilla.removeFinishedWorktrees`: `auto` (default), `ask` (every removal is a question), `off`.

## Part 2: New worktrees share big folders through hard links

### Setting

`flotilla.linkFolders`: string array, default `[]`, e.g. `["node_modules"]`. Paths are relative to the main worktree,
like `flotilla.copyFiles`. A missing folder is skipped.

Its description says: a hard-linked file is the same file in both worktrees, so a tool that edits a file in place
changes it in main too (npm and pnpm replace files, so installs are fine); use `npm install` as the setup command, not
`npm ci`, which deletes the folder first.

### Where

`createWorkstream` ([commands.ts](../../../src/ui/commands.ts)): after `copySetupFiles`, before `startSetupTerminal`,
inside the "Creating worktree…" progress.

### How

`linkFolder(from, to)` in `src/features/worktrees/setup.ts`, next to `copySetupFiles`:

- Walks `from`; creates directories; hard-links files (`fs.link`); recreates symlinks with the same target (not
  followed); limited concurrency.
- Returns `{ files, skipped?: reason }`. The output channel says "Linked node_modules: 18,204 files" or why not.
- On `EXDEV`, `EPERM` or `ENOTSUP` on the first link, it removes the partial folder and returns `skipped`; the setup
  command installs it as today. Creating the worktree never fails because of linking.

### This repository

`.vscode/settings.json`: `"flotilla.linkFolders": ["node_modules"]`, and no setup command: a setup command opens a
terminal for every new worktree (the autopilot's too), and a linked `node_modules` already has what main has; an agent
that changes the dependencies installs them.

Measured on Windows (NTFS): this repository's `node_modules` (11,660 files, 183 MB) links in 7.4 s and takes 3.2 MB
(the directories).

## Testing

- `removalDecision`: one case per row of the table above.
- Link handling before removal: a symlink and (on Windows) a junction to a folder outside are removed, the folder
  outside is untouched.
- Freed size: a hard-linked file isn't counted.
- `linkFolder`: linked files share an inode with the source; a symlink stays a symlink with the same target; a fake
  `EXDEV` leaves no partial folder and returns `skipped`.
- By hand, in the playground: a ticket moved to Done loses its worktree and keeps its branch; a new worktree's
  `node_modules` is linked, and `npm install` in it adds a package without changing main's `node_modules`. The
  linking time for this repository's `node_modules` is measured and noted in the ticket.

## Tickets

Two children of BL-9 ("Stay fast with many worktrees…"), independent of each other: part 1 (remove a worktree once its
ticket is done) and part 2 (share big folders through hard links).
