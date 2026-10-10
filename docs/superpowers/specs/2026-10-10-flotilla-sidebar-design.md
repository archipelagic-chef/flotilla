# Flotilla sidebar: files, version control and chats per worktree

Date: 2026-10-10
Status: Agreed direction, phase 1 in progress
Mockup: https://claude.ai/artifact/FuVH5peJmXZmzPg9HXP1oe

## 1. Goal

Flotilla replaces VS Code's Explorer and Source Control for repositories that use worktrees, and adds the chats that run in them. Worktrees are both **root folders** (like a multi-root workspace) and **slices** that run across files, version control and chats.

## 2. Layout

One webview view (`flotilla.sidebar`), meant to be the whole sidebar (VS Code's activity bar hidden or moved to the top).

- **Worktree tabs across the top**, like editor tabs, in a stable order (main worktree first, then by branch). The first tab, **All**, shows every worktree; the others one each. Each tab has the worktree's color (from the theme's terminal palette), a dot for its most urgent chat state and its open-chat count. The strip scrolls sideways when the tabs don't fit.
- **The active worktree** is the selected tab. It is the window's context: the tools show it, new terminals start there, and the status bar shows it. Ctrl+Alt+0…9 switch it (0 = All). Remembered per window.
- **Tool strip down the left**: Overview, Files, Search, Version Control, Chats, with badges counted for the active worktree; Run and Debug and Extensions at the bottom.
  - *Overview*: every worktree, most urgent first; click one to open its tab.
  - *Files*, *Version Control*, *Chats*: one worktree with a header, or on the All tab every worktree as a section with a sticky header and a colored stripe.
  - *Search*: `git grep` (tracked and untracked, not ignored) in the active worktree or all of them; match case, whole word, regex; results grouped by worktree and file.

Built with Preact, `@vscode/codicons` and VS Code's theme variables. Context menus use VS Code's native webview context menus (`webview/context` + `data-vscode-context`), so file and chat actions are ordinary commands.

## 3. Chats

### 3.1 Sources

Claude Code only for now. The model (`Chat`, `ChatSource`) has a `source` field so Copilot Chat or others can be added once they offer an API for listing chats and reading their state.

1. **Hook records** (live state, shared by host and container): Claude Code hooks write one file per chat to `<worktree git dir>/flotilla/chats/<sessionId>.json`. The git dir of the main worktree is `.git`, a linked worktree's is `.git/worktrees/<id>`. Both environments see the same files.
2. **Transcripts** (history and titles, per environment): `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, where the encoded cwd replaces every non-alphanumeric character with `-`. The transcript gives the title (`ai-title` records) and timestamps.

A worktree's chats are the union of both, minus chats the user unlinked.

### 3.2 Hook record

```json
{ "sessionId": "…", "source": "claude-code", "state": "working | waiting-for-input | done | ended",
  "message": "optional text", "firstPrompt": "…", "cwd": "/abs/path", "linkedBy": "cwd | edit | manual",
  "linkedDirs": ["/abs/other/git/dir"], "startedAt": "ISO", "updatedAt": "ISO" }
```

Events: `SessionStart` → done (idle), `UserPromptSubmit` and `PostToolUse` → working, `Notification` → waiting-for-input, `Stop` → done, `SessionEnd` → ended.

**Linking by edits**: on `PostToolUse` with a `file_path` in another worktree, the hook adds that worktree's git dir to `linkedDirs` and mirrors the record there with `linkedBy: "edit"`. The chat then shows in both worktrees, tagged *via <branch>* in the second.

**Manual links**: *Link to worktree…* writes a record with `linkedBy: "manual"`; *Unlink* deletes the record and adds the id to `<git dir>/flotilla/unlinked.json` so transcripts don't bring it back.

### 3.3 State and attention

Open chats are those in `working` or `waiting-for-input`, plus `done` chats updated within the agent-status stale window. A worktree's agent state is its most urgent chat state (waiting → error → working → done). This replaces the single `workstream.json`, which is still read for compatibility.

### 3.4 Hooks installation

Flotilla installs its hooks into each worktree's `.claude/settings.local.json`. That file is per checkout, so each worktree needs its own. Installation happens:

- on *New workstream*,
- through *Flotilla: Install Claude Code Hooks* (all reachable worktrees),
- after an offer, when a worktree has transcripts but no Flotilla hooks.

Existing settings are merged and kept. Flotilla's entries are recognised by a marker and replaced on reinstall. `.claude/settings.local.json` is added to `.git/info/exclude`.

### 3.5 Starting, linking and resuming chats

Chats stay in the window you work in. VS Code's (or Claude Code's) own session list keeps showing all of them; Flotilla adds which worktree each belongs to.

- **New chat for a worktree** opens Claude Code in this window (`claude-vscode.editor.open(undefined, prompt)`), with the message box pre-filled: *Work in the git worktree at `.worktrees/x` (branch `x`)…*. Nothing is sent until you send it.
- **Linking the new chat**: Claude Code doesn't return the new session's id, so Flotilla remembers which sessions existed in this window's folder when the chat was started, and links the first new one that appears (transcripts or hook records; checked every 3 s while a link is pending, for up to an hour).
- **A link moves the chat**: the record in the window's own git dir gets `home: <target git dir>` and the target in `linkedDirs`, so the hook mirrors its live state there, and the chat is listed under the target worktree instead of the folder it runs in.
- **Claude Code's session list**: once the chat has an AI title, Flotilla appends a `custom-title` record ("feature/login: <title>") to its transcript, the record Claude Code's own Rename writes. A title the user set is never replaced (`flotilla.tagChatTitles`).
- **Opening a chat**: `claude-vscode.editor.open(sessionId)` in this window, for any chat. Claude Code looks for the session in the transcript folders of every worktree of the window's repository (`git worktree list`), so chats that run in other worktrees open here too.
- **Link a chat… / Unlink**: move an existing chat to a worktree, or back to the folder it runs in.

Copilot Chat later: start with `workbench.action.chat.open({ query, isPartialQuery: true })` and detect the new session the same way, once its sessions can be listed.

## 4. Phases

1. Webview shell (tabs, rail, sections, focus mode), Version Control and Chats tabs, chat records and hooks, Files tab browsing (lazy tree, open, reveal active file). Replaces the Workstreams tree view.
2. File operations: new file/folder, rename, delete to trash, copy/cut/paste, drag and drop (done, including across worktrees); still open: arrow-key navigation and multi-select.
3. Polish: file icon theme, offer to hide the built-in Explorer and Source Control, virtualised tree for very large folders.
