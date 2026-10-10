# Changelog

## 0.1.0 (preview)

First public release.

- Flotilla sidebar with worktree tabs (an **All** tab plus one per worktree, closable, labelled with ticket ids) and an **active worktree** that Ctrl+P, palette commands, new terminals and the status bar follow.
- Tools: **Overview** (every worktree, most urgent first), **Files** (with file operations across worktrees), **Search** (with replace), **Version Control** (commit, amend, publish, sync, stage and discard per worktree) and **Chats**.
- Claude Code chats linked to worktrees, with live state from hooks Flotilla installs per worktree; new chats start in this window and are linked to their worktree.
- Portable worktrees in `.worktrees/` that work from a host window and a devcontainer window at the same time.
- Explorer badges and a Flotilla submenu for worktree folders; Add to Workspace.
