# Flotilla

Run parallel workstreams (typically AI agent sessions) in git worktrees, and see at a glance which one needs you. Works on Windows, Linux and macOS hosts **and** in devcontainers, including a host window and a container window open on the same repository at the same time.

Flotilla doesn't replace Copilot Chat, Claude Code or any other agent. It **observes** (status, activity, progress), **routes** (one click to the right window) and **prepares** (worktree, setup, window). You run your agent in that window as usual.

## Features

- **Workstreams view**: every worktree, sorted by what needs you: waiting for input → error → working → done → active → idle → stale.
- **New workstream**: from a new, local or remote branch; created at `.worktrees/<branch>`, set up, and opened in a new window.
- **Changes and Compare**: see any worktree's uncommitted changes, or compare its branch with a base, without opening it.
- **Status bar**: current workstream, a count of workstreams that need you, and quick switching.
- **Notifications** when a workstream starts waiting for input or reports an error.

## Host + devcontainer: how it works

Git normally links worktrees with absolute paths, which differ between host (`C:\Users\me\repo`) and container (`/workspaces/repo`). Flotilla keeps worktrees inside the repository (`.worktrees/`, ignored through `.git/info/exclude`), rewrites each worktree's `.git` file to a **relative** path, and **locks** the worktree so `git worktree prune` in the other environment never deletes it. It works with git 2.17+ and doesn't need git 2.48's `relativeWorktrees` extension.

Worktrees created with plain `git worktree add` inside the repository are adopted automatically (`flotilla.autoAdopt`). Worktrees outside the repository are listed but only reachable from the environment that can see them.

**Tip:** if your host converts line endings (`core.autocrlf=true` on Windows), add a `.gitattributes` with `* text=auto eol=lf`. Otherwise files can show as modified in one environment but not the other.

**Native dependencies:** `node_modules` (or similar) installed on a Windows host won't run inside a Linux container. Use **Run Setup Here** to re-run setup in the environment you're in.

## Agent status

Agents report status by writing `workstream.json` into their worktree's git directory (`git rev-parse --git-dir`):

```json
{ "state": "working | waiting-for-input | done | error", "message": "optional text", "updatedAt": "2026-10-09T10:00:00Z" }
```

For Claude Code, run **Flotilla: Copy Claude Code Hook Config** and merge the result into `.claude/settings.json`. Flotilla never edits agent configuration itself.

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
