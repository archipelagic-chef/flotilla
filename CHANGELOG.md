# Changelog

## Unreleased

- **Worktrees take less space**: a done ticket's worktree is removed when nothing in it can be lost and nobody is using it, keeping its branch (`flotilla.removeFinishedWorktrees`); a new worktree can get big folders such as `node_modules` as hard links to the main worktree's (`flotilla.linkFolders`).

- **Tickets stay current with main**: open tickets' branches are checked against main when it moves (a merge in memory); a conflict shows on the card and in the ticket, *Update from Main* merges main in (or hands the conflicts to the ticket's agent), and a ticket can depend on another ("Depends on: BL-12").

## 0.2.0 (preview)

- **Backlog**: tickets with status, priority, sub-tickets, worktrees, commits and an activity feed (comments, agents' reports, every change), in editor tabs. Images and file links in tickets.
- **Agents on tickets**: start one from a ticket, with its model and effort; agents report in the ticket, prefix commits with its id, keep its description up to date, ask when they need you, and say how to review their work.
- **Any chat works through the backlog**, and agents can add tickets and sub-tickets (proposals by default).
- **Reviews**: a reviewer agent, your own Approve / Request Changes, and fixes for a stopped review.
- **Autopilot**: agents take To Do tickets by themselves; agents that hit Claude's usage limit go on when it resets.
- **History clean-up**: rewrite a ticket's branch into clean commits, keeping the old history.
- **Jira and GitHub Issues**: list, link, comment, change status and priority, create issues; every write asks first.
- Chats: the Chats icon counts chats waiting for you; an active chat is selected where it runs.
- Version Control: images open in VS Code's image preview from a commit; a ticket's commit opens highlighted in the history.

## 0.1.0 (preview)

First public release.

- Flotilla sidebar with worktree tabs (an **All** tab plus one per worktree, closable, labelled with ticket ids) and an **active worktree** that Ctrl+P, palette commands, new terminals and the status bar follow.
- Tools: **Overview** (every worktree, most urgent first), **Files** (with file operations across worktrees), **Search** (with replace), **Version Control** (commit, amend, publish, sync, stage and discard per worktree) and **Chats**.
- Claude Code chats linked to worktrees, with live state from hooks Flotilla installs per worktree; new chats start in this window and are linked to their worktree.
- Portable worktrees in `.worktrees/` that work from a host window and a devcontainer window at the same time.
- Explorer badges and a Flotilla submenu for worktree folders; Add to Workspace.
