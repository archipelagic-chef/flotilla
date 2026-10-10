# Flotilla

Work on several branches at once, each in its own git worktree, from one VS Code window: files, search, version control and Claude Code chats per worktree, and a view of which worktree needs you. Works on Windows, Linux and macOS hosts **and** in devcontainers, including a host window and a container window open on the same repository at the same time.

Flotilla doesn't replace Claude Code or any other agent. Your chats run in Claude Code as usual; Flotilla links each one to its worktree and shows whether it is working, waiting for you or finished.

> **Preview:** Flotilla is young and changes quickly. Feedback and bug reports are welcome on [GitHub](https://github.com/archipelagic-chef/flotilla/issues).

## Features

Flotilla is meant to be your sidebar. **Worktree tabs** run across its top, like editor tabs: the first, **All**, shows every worktree at once; the others show one worktree each. The selected tab is the window's **active worktree**: Ctrl+P lists its files, commands from the palette act on it, new terminals (*Flotilla: New Terminal in Active Worktree*) start in it, the status bar shows it, and Ctrl+Alt+0…9 switch it (0 is All). Each tab shows the worktree's ticket id (`ABC-123`, `#123`) or short name, its color, a dot for its most urgent chat state and its open chats. Close tabs you don't need (×, middle-click or right-click); the worktree stays in the Overview, and opening it there reopens its tab.

A **tool strip** runs down its left side:

- **Overview**: every worktree, most urgent first, with its status, changes, sync state and the question a chat is waiting on. Double-click one to open it; remove worktrees from here or from a tab's context menu.
- **Files**: the file tree with git change badges, reveal of the active editor's file, new file and folder (inline, `a/b/c.ts` creates the folders), rename (F2), delete to the Trash (Delete), cut/copy/paste (also between worktrees) and drag and drop.
- **Search**: text search and replace in the active worktree (or all of them on the All tab), with match case, whole word and regex. It searches tracked and untracked files and skips ignored ones.
- **Version Control**: like VS Code's Source Control, per worktree: a message box with Commit (and Commit & Push, Commit & Sync, Amend), Publish Branch or Sync Changes, and staged and unstaged changes with stage, unstage and discard.
- **Chats**: the Claude Code chats linked to the worktree, with their state (working, waiting for you, finished), *New chat* and the history of every chat linked to it.

At the bottom of the strip, buttons open VS Code's Run and Debug and Extensions views. To keep a single icon strip, move VS Code's activity bar to the top or hide it (`workbench.activityBar.location`); Flotilla offers this once (*Flotilla: Use Flotilla as the Sidebar…*). With it hidden, the Flotilla item in the status bar and Ctrl+Shift+E / F / G bring Flotilla back.

Also:

- **New workstream**: from a new, local or remote branch; created at `.worktrees/<branch>` and set up.
- **Compare** a worktree's branch with a base in VS Code's multi-file diff editor.
- **Explorer integration**: worktree folders and the changed files inside them carry badges in VS Code's Explorer, with a **Flotilla** submenu. **Add to Workspace** shows a worktree as its own Explorer root.
- **Status bar**: current workstream, a count of workstreams that need you, and quick switching.
- **Notifications** when a workstream starts waiting for input or reports an error.

## Host + devcontainer: how it works

Git normally links worktrees with absolute paths, which differ between host (`C:\Users\me\repo`) and container (`/workspaces/repo`). Flotilla keeps worktrees inside the repository (`.worktrees/`, ignored through `.git/info/exclude`), rewrites each worktree's `.git` file to a **relative** path, and **locks** the worktree so `git worktree prune` in the other environment never deletes it. It works with git 2.17+ and doesn't need git 2.48's `relativeWorktrees` extension.

Worktrees created with plain `git worktree add` inside the repository are adopted automatically (`flotilla.autoAdopt`). Worktrees outside the repository are listed but only reachable from the environment that can see them.

**Tip:** if your host converts line endings (`core.autocrlf=true` on Windows), add a `.gitattributes` with `* text=auto eol=lf`. Otherwise files can show as modified in one environment but not the other.

**Native dependencies:** `node_modules` (or similar) installed on a Windows host won't run inside a Linux container. Use **Run Setup Here** to re-run setup in the environment you're in.

## Chats and agent status

Run **Flotilla: Install Claude Code Hooks** (or accept the offer). Flotilla adds hooks to each worktree's `.claude/settings.local.json`, which it keeps out of git, and to every new worktree after that. The hooks need Node.js on the PATH. Each chat then writes its state to `<worktree git dir>/flotilla/chats/<session>.json`, which host and container windows both read. Chat titles and history come from Claude Code's transcripts in `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR`), in the environment the window runs in.

Chats stay in the window you work in. **New chat** on a worktree opens Claude Code here with the message box pre-filled with where to work, and links the chat to that worktree once you send the first message. Clicking a chat opens it in Claude Code's panel; a chat that ran in another worktree's folder is first copied to this window's folder (the original stays). Linked chats are listed under their worktree in the Chats tab, and renamed to "<branch>: <title>" in Claude Code's own session list (`flotilla.tagChatTitles`). Use **Link a Chat to This Worktree…** and **Unlink** to move chats by hand. Only Claude Code chats are tracked for now.

Other tools can still report a worktree-wide status by writing `workstream.json` into the worktree's git directory:

```json
{ "state": "working | waiting-for-input | done | error", "message": "optional text", "updatedAt": "2026-10-09T10:00:00Z" }
```

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `flotilla.copyFiles` | `[]` | Globs copied from the main worktree on create |
| `flotilla.setupCommand` | `""` | Run in a terminal in the new worktree |
| `flotilla.autoAdopt` | `true` | Make in-repo worktrees portable automatically |
| `flotilla.defaultBase` | `""` | Base branch for progress and compare |
| `flotilla.activeWindowMinutes` | `5` | Activity → active threshold |
| `flotilla.staleAfterDays` | `7` | Activity → stale threshold |
| `flotilla.agentStatusStaleMinutes` | `10` | When a `working` report is considered stale |
| `flotilla.notifyOnAttention` | `true` | Notify on waiting-for-input / error |
| `flotilla.pollSeconds` | `15` | Poll interval while the view is visible |
| `flotilla.tagChatTitles` | `true` | Rename linked chats to "<branch>: <title>" in Claude Code's session list |
| `flotilla.tabLabelPattern` | `""` | Regular expression for the id shown on worktree tabs (default: Jira keys and issue numbers) |

## Requirements

- git 2.17 or newer in each environment (host and container).
- For chat status: [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), and Node.js on the PATH where it runs (the hooks are small Node scripts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and trying Flotilla across host and devcontainer.
