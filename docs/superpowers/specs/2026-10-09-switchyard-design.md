> **Renamed:** this project was later renamed from Switchyard to **Flotilla** (identifiers `switchyard.*` became `flotilla.*`). This document is kept as the historical record.

# Switchyard — Design Spec (Sub-project 1: Core + Workstreams)

Date: 2026-10-09
Status: Draft for review

## 1. Purpose

Switchyard is a VS Code extension for running several parallel workstreams in one repository, typically AI agent sessions (Claude Code, Copilot Chat, …), each in its own git worktree. It answers two questions at a glance:

- **Which workstream needs me right now, and what is each one doing?**
- **How do I quickly start new work, or switch to existing work?**

It must work identically on a Windows, Linux or macOS host and inside a devcontainer, **including when a host window and a devcontainer window are open on the same repository at the same time**.

### Design principle: amplify, don't replace

Switchyard has no chat UI. It doesn't launch, drive or talk to agents, and it doesn't duplicate what Copilot Chat or Claude Code already do. It **observes** (status, activity, progress), **routes** (one click to the right window) and **prepares** (creates the worktree, runs setup, opens the window). The user runs their agent of choice in that window as usual.

## 2. Overall roadmap (context only; this spec covers sub-project 1)

| # | Sub-project | Contents |
|---|---|---|
| **1** | **Core + workstreams** (this spec) | Shared git layer, cross-environment worktrees, workstream overview, worktree diffs |
| 2 | Worktree-aware working-tree ops | Stage/unstage (hunk/line), commit, stash, per worktree from one place. Motivation: VS Code's built-in SCM is per-window/per-folder and breaks down across many worktrees. |
| 3 | History & graph | Commit graph webview, commit details, compare any two refs, file history, blame |
| 4 | Branch & rebase ops | Checkout, merge, (interactive) rebase editor, cherry-pick, reset, conflict helpers |
| 5 | Pull requests | Provider abstraction (GitHub, GitLab, Bitbucket, generic); list/check out PRs into worktrees, diffs, comments |

Sub-project 1 must design its core layer so 2–5 can be added as new `features/*` modules without restructuring.

## 3. Requirements

### 3.1 Functional (v1)

1. **Create a workstream** from a new branch (based on HEAD or a chosen ref), an existing local branch or a remote branch (creates a tracking branch). Afterwards, optionally open it in a new window, switch the current window to it, or do nothing (configurable).
2. **Open/switch** to any reachable worktree, in a new window or the current one.
3. **Remove** a worktree, with safety checks, and optionally delete its branch.
4. **Workstream overview** in a sidebar: agent status, activity, progress, open-window indicator; sorted by attention.
5. **Status bar** item showing the current worktree, with a quick-switch picker.
6. **Post-create setup**: copy configured ignored files from the main worktree; run a setup command.
7. **Diff 1**: view any worktree's uncommitted changes without opening it.
8. **Diff 2**: compare a worktree's branch with a base branch (merge-base by default).
9. **Interoperability**: worktrees created with plain `git` are listed and usable; worktrees created by Switchyard are normal git worktrees that plain `git` and other tools can use.
10. **Attention notifications** when a workstream enters *waiting-for-input* or *error*.

### 3.2 Cross-environment

- Works on Windows, Linux and macOS hosts and in Linux devcontainers.
- A host window and a devcontainer window can be open on the same repo at the same time; neither breaks the other's worktrees.
- Minimum git: **2.17** (`git worktree remove`). Doesn't require 2.48 relative-worktree support and never enables `extensions.relativeWorktrees`.

### 3.3 Non-goals (v1)

- Chat UI, starting agents, or editing agent configuration files.
- GitHub PR support (sub-project 5), staging/commit/stash (sub-project 2), history (sub-project 3).
- Bare-repository layouts, submodules and worktrees of submodules.
- Communication between windows (all shared state lives in the repo).
- Solving native-dependency differences between host and container OS (documented; mitigated with "Run setup here").

## 4. Architecture

### 4.1 Runtime model

- `"extensionKind": ["workspace"]`: the extension runs where the workspace's files are (inside the container for a devcontainer window, on the host for a local window) and uses that environment's `git`.
- Each window is self-contained. The only shared state lives in the repository: `.worktrees/`, `.git/worktrees/*`, lock files, heartbeat files and status files.

### 4.2 Module layout

```
src/
  extension.ts              activation; wires services, views, commands, refresh loop
  core/
    git/
      gitCli.ts             execFile wrapper: cwd, timeout, typed GitError (args, exitCode, stderr), version check
      porcelain.ts          parsers: `worktree list --porcelain`, `status --porcelain=v2 --branch -z`,
                            `diff --name-status -z`, `diff --numstat -z`
    repoLocator.ts          from any folder, find main worktree root + common git dir
                            (`git rev-parse --show-toplevel --git-common-dir --git-dir`)
    repository.ts           Repository model: one per main repo; holds Worktree[]; emits onDidChange
    refresh.ts              refresh orchestration: watchers + window focus + polling + manual
    diff/
      gitContentProvider.ts `switchyard-git:` TextDocumentContentProvider (`git show <ref>:<path>`)
      openDiff.ts           helper: builds left/right URIs, handles added/deleted/renamed, calls vscode.diff
    uris.ts                 build workspace-compatible URIs for paths (preserves scheme + remote authority)
  features/
    worktrees/
      layout.ts             `.worktrees/<name>` naming, sanitisation, collision suffixes, info/exclude
      resolver.ts           map `.git/worktrees/<id>` entries to real paths in THIS environment
      portability.ts        makePortable, isPortable, retargetBackPointer (repair), adopt
      worktreeService.ts    list / create / remove / open; only entry point used by UI
      setup.ts              copyFiles + setup command in terminal
    workstreams/
      activity.ts           newest-mtime scan → active / idle / stale
      progress.ts           diff stats vs base, ahead/behind, last commit subject
      heartbeat.ts          write own heartbeat; read others'
      agentStatus.ts        read/validate workstream.json; staleness
      attention.ts          attention ranking + notification transitions
    diffs/
      changesNode.ts        Diff 1 tree nodes
      compareNode.ts        Diff 2 tree nodes + base selection
  ui/
    workstreamsView.ts      TreeDataProvider for the Workstreams view
    statusBar.ts
    commands.ts
```

Rules:
- `core/` has no knowledge of worktree layout, workstreams or UI.
- `features/*` depend on `core/`, not on each other, except `workstreams` → `worktrees` (it reads the worktree list) and `diffs` → `worktrees`.
- `ui/` depends on `features/` services, never on `gitCli` directly.

### 4.3 Views

- A dedicated **activity-bar container** "Switchyard". v1 has one view, **Workstreams**. Later sub-projects add views (History, Stashes, PRs) to the same container.
- The status bar item lives in `ui/statusBar.ts`.

## 5. Cross-environment worktree design

### 5.1 Problem

Git links a linked worktree to its repo in both directions using absolute paths:

- `<worktree>/.git` (a file): `gitdir: <abs path to .git/worktrees/<id>>`. Every git command run in the worktree reads this.
- `.git/worktrees/<id>/gitdir`: `<abs path to <worktree>/.git>`. Read by `worktree list`, `prune`, `remove` and `move`.

The host sees the repo at e.g. `C:\Users\me\repo` and the container sees it at `/workspaces/repo`, so an absolute path written in one environment is invalid in the other.

### 5.2 Layout

- Managed worktrees live at `<mainRoot>/.worktrees/<name>`. Because they are inside the repo folder, every devcontainer that mounts the repo can see them.
- `<name>` = branch name with `/`, `\` and characters that aren't allowed in file names replaced by `-`; if the name is taken, `-2`, `-3`, … is appended.
- On first create, `.worktrees/` is added to `.git/info/exclude` (local, never committed) if it isn't already there.

### 5.3 Making a worktree portable

After `git worktree add`, `portability.makePortable(wt)`:

1. Rewrites `<worktree>/.git` to `gitdir: <relative path from worktree dir to <commonDir>/worktrees/<id>>`, using forward slashes (e.g. `gitdir: ../../.git/worktrees/feature-login`). Git has resolved relative `gitdir:` paths relative to the `.git` file's directory for a long time (submodules depend on it), so this works on every supported git version and in every environment.
2. Runs `git worktree lock --reason "switchyard: portable" <path>`. A locked worktree is never removed by `git worktree prune` or `git gc`, even when its back-pointer doesn't resolve in the current environment.

The back-pointer (`.git/worktrees/<id>/gitdir`) stays absolute, in the format of whichever environment last wrote it.

`isPortable(wt)` = the `.git` file holds a relative `gitdir:` **and** the worktree is locked (any reason).

### 5.4 Resolving worktree locations (`resolver.ts`)

For each directory `<commonDir>/worktrees/<id>`:

1. Read `gitdir` (the back-pointer). If that path exists in this environment → location = its parent directory.
2. Otherwise, scan `<mainRoot>/.worktrees/*/.git` (files only) for one whose `gitdir:` resolves to `<commonDir>/worktrees/<id>`. If found → location = that directory.
3. Otherwise → mark **unreachable**; keep the recorded path for display.

Branch, HEAD and lock state come from `git worktree list --porcelain` and are matched by `<id>` (derived from the admin directory path), not by path.

### 5.5 Adoption (worktrees created outside Switchyard)

On each refresh, for every reachable worktree **inside `<mainRoot>`** that isn't portable:
- If `switchyard.autoAdopt` is `true` (the default), call `makePortable`. If it's already locked by someone else, keep their lock and only rewrite the `.git` file.
- If `false`, show a "not portable" marker and an **Adopt** action.

Worktrees **outside** `<mainRoot>` are never modified; they're listed and usable in the environment that can reach them.

If `extensions.relativeWorktrees` is set in the repo config and the local git is older than 2.48, show one warning explaining that this environment's git can't read the repo.

### 5.6 Retargeting before mutating (`retargetBackPointer`)

Before `remove` or any other operation that uses the back-pointer, if `gitdir` doesn't resolve in this environment, overwrite `.git/worktrees/<id>/gitdir` with the absolute path of `<worktree>/.git` as seen here. This does what `git worktree repair` (2.29+) does, without requiring that version.

## 6. Flows

### 6.1 Create / New workstream

1. Quick pick: *New branch…* / *Existing local branch* / *Remote branch*. For a new branch: name input, then base ref (default: current HEAD).
2. Compute `<name>`; ensure the exclude entry.
3. `git worktree add [-b <branch>] [--track] <path> <ref>`.
4. `makePortable`.
5. Setup (§6.5).
6. Post-create action per `switchyard.openAfterCreate`: `"newWindow"` (default) | `"currentWindow"` | `"none"`.

### 6.2 Open / switch

Build the target URI with `uris.ts` from the current workspace folder URI (same scheme and authority, new path), then call `vscode.openFolder(uri, { forceNewWindow })`. From a devcontainer window this opens the worktree in the same container; from a host window, on the host.

### 6.3 Remove

1. Gather state: uncommitted/untracked changes (`status`), commits not on any remote (`git log <branch> --not --remotes`).
2. Confirm. The dialog lists any risks and always notes: "If this worktree is open in another window (including another environment), that window will lose its folder."
3. If the worktree is the current window's folder, switch this window to the main worktree first (the removal continues in the reopened window via a pending-action entry in `globalState`).
4. `retargetBackPointer` if needed → `git worktree unlock` (if locked) → `git worktree remove [--force]`.
5. Offer to delete the branch (`git branch -d`; if that fails because it isn't merged, offer `-D` with a warning).

### 6.4 Adopt

Covered in §5.5; also available as a manual command.

### 6.5 Setup

- `switchyard.copyFiles: string[]`: globs relative to the main worktree (e.g. `[".env", ".env.*"]`). Matching files are copied, preserving relative paths, without overwriting.
- `switchyard.setupCommand: string`: run in a new VS Code terminal whose cwd is the worktree. A failure doesn't roll back the worktree.
- **Run setup here** command: re-runs both steps for a worktree in the current environment (for host/container OS differences such as native `node_modules`).

### 6.6 Workspace hygiene prompt

The first time Switchyard creates or adopts a worktree in a repo, it offers once (remembered per repo in `workspaceState`) to add `**/.worktrees` to `git.repositoryScanIgnoredFolders`, `files.watcherExclude` and `search.exclude`, at workspace or user level, so the main window doesn't treat worktrees as extra repositories or search results.

## 7. Workstream overview

### 7.1 Tree layout

```
⎇ feature-login        ⏸ waiting for input · 2m
   "Need approval to run migrations" · ↑3  +120 −40 · 🪟 container
   ▸ Changes (4)
   ▸ Compare: feature-login ↔ main
⎇ fix-flaky-test       ⚙ working · 10s
⎇ main                 ○ idle · 3h
⎇ old-spike            ⊘ unreachable from this environment
```

Sort order (attention rank): waiting-for-input → error → working → done → active → idle → stale → unreachable. Ties are broken by most recent activity. The current window's worktree is marked.

Inline actions: Open in new window, Switch here, Remove. Context menu: Reveal in Explorer, Open terminal here, Copy path, Run setup here, Adopt, Compare with…, Clear agent status.
Title actions: New workstream, Refresh.

### 7.2 Signals

**Activity (`activity.ts`)**: newest mtime among files listed by `git status --porcelain=v2 -z` plus the worktree's `HEAD` reflog mtime (`<gitdir>/logs/HEAD`). Status: *active* if within `switchyard.activeWindowMinutes` (default 5), *stale* if older than `switchyard.staleAfterDays` (default 7), otherwise *idle*.

**Progress (`progress.ts`)**: `git diff --numstat <mergeBase>` (working tree vs merge-base with the base, summed), `git rev-list --left-right --count <base>...HEAD`, and `git log -1 --format=%s`. The base is resolved as in §8.2.

**Open window (`heartbeat.ts`)**: every 30 s each window writes `<its own gitdir>/switchyard-window.json`:
```json
{ "env": "host" | "container", "os": "win32" | "linux" | "darwin", "updatedAt": "<ISO>" }
```
(`env` is `"container"` when `vscode.env.remoteName === "dev-container"` or `"attached-container"`, otherwise `"host"`.) A heartbeat newer than 90 s means a window is open there. The heartbeat file is deleted on deactivate (best effort).

**Agent status (`agentStatus.ts`)**: `<gitdir>/workstream.json`, written by agents:
```json
{ "state": "working" | "waiting-for-input" | "done" | "error", "message": "string (optional)", "updatedAt": "<ISO>" }
```
- `<gitdir>` = `git rev-parse --git-dir` run inside the worktree (for the main worktree that's `.git`).
- Invalid JSON or an unknown `state` is ignored (logged to the output channel).
- If `updatedAt` is more than `switchyard.agentStatusStaleMinutes` (default 10) old and `state` is `working`, it's shown greyed out as "last reported". The ranking then falls back to activity.
- **Clear agent status** deletes the file.

### 7.3 Claude Code integration (copy-only)

The command **Switchyard: Copy Claude Code hook config** copies a JSON snippet for `.claude/settings.json` that maps:
- `UserPromptSubmit` → `working`
- `Notification` → `waiting-for-input`
- `Stop` → `done`

Each hook runs a cross-platform `node -e` one-liner that runs `git rev-parse --git-dir` and writes `workstream.json`. Switchyard never writes agent config files itself. The README documents the file format for other agents.

### 7.4 Attention notifications (`attention.ts`)

When a workstream's state changes into `waiting-for-input` or `error` (compared with the previous refresh, in this window), show an information/warning message with **Open window** / **Switch here** buttons. Controlled by `switchyard.notifyOnAttention` (default `true`). The current window's own worktree is excluded.

## 8. Diffs

### 8.1 Diff 1: uncommitted changes

- The **Changes (n)** node under each reachable worktree lists entries from `git status --porcelain=v2 -z` with icons for M/A/D/R/U (untracked).
- Click → `vscode.diff(left = switchyard-git:<wt>?ref=HEAD&path=<p>, right = workspace file URI, "<file> (<wt>: HEAD ↔ working)")`.
  - Added/untracked: left is empty. Deleted: right is empty (`switchyard-git` with `ref=EMPTY`).
  - Renamed: the left side uses the original path.
- Staged and unstaged changes are combined (HEAD ↔ working copy); separating them is in sub-project 2.

### 8.2 Diff 2: compare with base

- **Compare with…** on a worktree → quick pick of branches; default base = `switchyard.defaultBase`, else `origin/HEAD`, else `main`, else `master`.
- Default mode: merge-base, `git diff --name-status -z -M <base>...HEAD`.
- Toggles on the compare node: **Two-dot** (`<base>..HEAD`, direct) and **Include uncommitted** (merge-base ↔ working tree: `git diff --name-status -z -M $(git merge-base <base> HEAD)`).
- File click → diff between the two sides with the content provider (working files use the workspace URI).
- The compare node stays until it's dismissed; one per worktree.

### 8.3 Content provider

`switchyard-git:` URIs: path = file path (for editor tab labels); query = JSON `{ worktree, ref, path }`. Content = `git -C <worktree> show <ref>:<path>`; `ref=EMPTY` or a missing path → empty document. Read-only. Reused by later sub-projects.

## 9. Refresh model

`Repository.refresh()` is debounced (300 ms) and triggered by:
- `FileSystemWatcher` on `<commonDir>/worktrees/**` and `<mainRoot>/.worktrees/*/` (top level),
- `window.onDidChangeWindowState` (focused),
- polling every `switchyard.pollSeconds` (default 15) while the Workstreams view is visible,
- the manual Refresh command.

Polling is needed because file events from a Docker bind mount (especially Windows host → container) are unreliable.

## 10. Errors and edge cases

- `git` missing or older than 2.17 → one error message; commands disabled; the view shows a welcome message explaining the requirement.
- All git calls use `execFile` (no shell), have a timeout (default 30 s; `worktree add` 120 s), and on failure produce a `GitError` whose stderr is shown to the user.
- Not inside a git repo → the view shows a welcome message.
- Concurrent operations from two windows: rely on git's own locking; surface git's error; no retries.
- Branch already checked out in another worktree → git's error, shown with a hint offering to open that worktree.
- Paths with spaces or non-ASCII characters: always pass them as separate arguments; use `-z` output formats.
- All paths go through `path.posix`/`path.win32` according to `process.platform`; paths written into `.git` files always use forward slashes.

## 11. Settings

| Setting | Default | Purpose |
|---|---|---|
| `switchyard.openAfterCreate` | `"newWindow"` | `newWindow` / `currentWindow` / `none` |
| `switchyard.copyFiles` | `[]` | Globs copied from the main worktree on create |
| `switchyard.setupCommand` | `""` | Run in a terminal in the new worktree |
| `switchyard.autoAdopt` | `true` | Make in-repo worktrees portable automatically |
| `switchyard.defaultBase` | `""` | Base branch for progress and compare |
| `switchyard.activeWindowMinutes` | `5` | Activity → active threshold |
| `switchyard.staleAfterDays` | `7` | Activity → stale threshold |
| `switchyard.agentStatusStaleMinutes` | `10` | When a `working` report is considered stale |
| `switchyard.notifyOnAttention` | `true` | Notify on waiting-for-input / error |
| `switchyard.pollSeconds` | `15` | Poll interval while the view is visible |

## 12. Development environment

- `.devcontainer/devcontainer.json`: Node LTS image, the `ghcr.io/devcontainers/features/git` feature, and `xvfb` (plus the libraries VS Code needs) for headless integration tests.
- TypeScript, bundled with esbuild; `@vscode/vsce` for packaging.
- `engines.vscode`: `^1.95.0`.

## 13. Testing

- **Unit (vitest)**: porcelain parsers, layout naming, the relative-path computation in `portability`, the resolver (with an injected fs), activity/attention ranking, agent-status validation.
- **Integration (`@vscode/test-cli` + real git, via xvfb)**:
  - create → portable → `git status` works inside the worktree;
  - **cross-environment simulation**: create a repo and worktree at path A, then copy (or symlink) the entire repo to path B; from B, check that `git -C <B>/.worktrees/x status` works, the resolver finds the worktree through the `.worktrees` scan, and remove succeeds after the back-pointer is retargeted; then verify that `git worktree prune` at A doesn't delete a locked entry;
  - adoption of a worktree created with plain `git worktree add`;
  - Diff 1 / Diff 2 file lists against known fixtures;
  - agent status file → view state + attention ranking.
- **CI matrix**: Linux with git 2.17 (built from source in a container image, since current runners ship newer git) and current git; Windows with current git.
- **Manual acceptance**: a real Windows host + devcontainer with two windows on the same repo, covering create on each side, open on the other, and remove from the other.
