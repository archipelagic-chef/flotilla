# Flotilla

Run parallel workstreams (typically AI agent sessions) in git worktrees, and see at a glance which one needs you. Works on Windows, Linux and macOS hosts **and** in devcontainers, including a host window and a container window open on the same repository at the same time.

Flotilla doesn't replace Copilot Chat, Claude Code or any other agent. It **observes** (status, activity, progress), **routes** (one click to the right window) and **prepares** (worktree, setup, window). You run your agent in that window as usual.

## Features

The Flotilla sidebar shows every worktree of the repository at once, with three tabs across the top:

- **Files**: each worktree's file tree, with git change badges. The active editor's file is revealed in its own worktree. New file and folder (inline, `a/b/c.ts` creates the folders), rename (F2), delete to the Trash (Delete), cut/copy/paste (also between worktrees), and drag and drop, from the right-click menu or the keyboard.
- **Version Control**: per worktree, a commit message box, publish/sync, and staged and unstaged changes with stage, unstage and discard.
- **Chats**: the Claude Code chats linked to each worktree: open chats with their state (working, waiting for you, finished), *New chat*, and the history of every chat linked to it. A chat that runs elsewhere but edits a worktree's files is linked to it as well.

The **rail** on the left has a tile per worktree, with a dot for the most urgent chat state and a count of open chats. Each worktree has a color, shared by its tile and the stripe along its section; the tile of the section at the top of the list is highlighted. Click a tile to scroll to that worktree; double-click it to show only that worktree (Esc or *Show all* to go back). Right-click a worktree, file, change or chat for its actions.

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

Chats stay in the window you work in. **New chat** on a worktree opens Claude Code here with the message box pre-filled with where to work, and links the chat to that worktree once you send the first message. Linked chats are listed under their worktree in the Chats tab, and renamed to "<branch>: <title>" in Claude Code's own session list (`flotilla.tagChatTitles`). Use **Link a Chat to This Worktree…** and **Unlink** to move chats by hand. Only Claude Code chats are tracked for now.

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

## Development

Open the folder in the devcontainer (or on the host with Node 22 and git), then:

```bash
npm ci
npm test               # unit + git integration tests (vitest)
npm run typecheck
npm run build
xvfb-run -a npm run test:vscode   # in the container; plain `npm run test:vscode` on a desktop
docker build -f test/docker/old-git.Dockerfile -t flotilla-oldgit . && docker run --rm flotilla-oldgit
```

Press F5 ("Run Extension (playground)") to launch an Extension Development Host opened on `.playground/`, a throwaway repo that `npm run playground` creates on first launch.

The devcontainer keeps its own `node_modules` in a Docker volume, so installing in the container never breaks the host's (and vice versa). It also installs the Claude Code extension; log in once inside the container and the login is kept in a volume across rebuilds.

### Testing across host and container

The extension only loads in a test window started from a window where **this project** is open. Reopening a test window in a container drops the extension, so start one test window on each side:

1. **Host:** open this project locally and press F5. A test window opens on `.playground` (host paths).
2. **Container:** open the project in a second window with *Dev Containers: Reopen in Container* and press F5 there. A second test window opens on the same `.playground`, running inside the container.
3. Now exercise both sides on the same repo, for example:
   - create a workstream in one window; it appears in the other within ~15 s (or when you focus it);
   - open it from the other window (right-click → Open in New Window) and run `git status` there;
   - run `git worktree prune` in each environment; no Flotilla worktree disappears;
   - write `{"state":"waiting-for-input","message":"test","updatedAt":"<now ISO>"}` to the worktree's `workstream.json` (in `.playground/.git/worktrees/<name>/`) on one side; the other window shows it;
   - remove a workstream from the side that did not create it;
   - run `git worktree add .worktrees/manual -b manual` in a host terminal inside `.playground`; it shows in both windows and works in the container after the next refresh.

Both sides build into the same `dist/`: after a code change, stop both debug sessions and press F5 again.
