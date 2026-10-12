# Contributing to Flotilla

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

The playground's backlog and worktrees are seeded with every state Flotilla handles (To Do, an epic, a question from an agent, In Review with run blocks of each kind, approved, stopped, paused on a usage limit, Done; worktrees ahead, behind and with changes), by `scripts/playground-seed.mjs`. To seed it again, delete `.playground/.flotilla` and run `npm run playground`; worktrees that exist are kept.

An existing playground is never reset by F5; if it was built by an older version of `scripts/playground.mjs`, the task output says so. To start over, run `npm run playground -- --reset` or launch "Run Extension (fresh playground)". The old playground is moved to `.playground.old-<date>` (its worktrees move with it and keep working there, uncommitted changes included).

The devcontainer keeps its own `node_modules` in a Docker volume, so installing in the container never breaks the host's (and vice versa). It also installs the Claude Code extension; log in once inside the container and the login is kept in a volume across rebuilds.

## The debug window's profile

The debug window doesn't use your VS Code profile. Its settings, secret storage, GitHub sign-in and Flotilla's own state live in `.vscode-test/debug-profile`, and its extensions in `.vscode-test/debug-extensions` (both git-ignored). Only Claude Code is in there, a copy of the one you have installed, so chats still work; your installed Flotilla doesn't run next to the one being debugged. Every F5 (and every `npm run playground`) makes this ready; `scripts/debug-profile.mjs` does the work.

The fakes are off by default, so agents and the CI/CD view use the real Claude and GitHub. To switch them on for the debug window:

```bash
npm run debug-profile -- --fakes     # Flotilla's Claude (flotilla.agents.claudePath) and GitHub (flotilla.dev.githubApi) point at the fakes
npm run debug-profile -- --no-fakes  # back to the real ones
npm run debug-profile                # keeps the last choice; F5 does this too
```

The fakes are `scripts/fake-claude.mjs` and `scripts/fake-github.mjs`; a fake that isn't in `scripts/` isn't used, and the log says so. To start the debug window's profile over (its first-run offers come back), close the debug window and delete `.vscode-test/debug-profile`.

The script edits the debug profile's `User/settings.json` and keeps the settings it doesn't manage. That file must be plain JSON: VS Code allows comments in settings, but if you add one, the script leaves the file as it is and says so (the fakes aren't switched then).

To check once, by hand, that a debug session leaves your own VS Code alone:

1. Close your VS Code windows. Note the checksums of your user files, `User/settings.json` and `User/globalStorage/state.vscdb`, and `ls -R User/globalStorage`. Where the user folder is: `~/.vscode-server/data/User` in a dev container, `%APPDATA%\Code\User` on Windows, `~/Library/Application Support/Code/User` on macOS (`sha256sum`, or `certutil -hashfile` on Windows).
2. Press F5, and in the debug window sign in to GitHub, answer the offers and turn the autopilot on. Close the debug window.
3. Check the same checksums and listing again: they must not have changed. `.vscode-test/debug-profile` now holds what the debug window wrote.

What this covers: the two files and the folder listing, on every platform. What it doesn't cover: secret storage (the autopilot key, the GitHub sign-in). Where VS Code keeps secrets wasn't traced: they aren't visible in `state.vscdb` in the dev container, and on desktop they're probably in the OS credential store (Credential Manager on Windows, Keychain on macOS, the keyring on Linux). That isn't verified, so check it by hand: look for the entries your profile has, note them, and compare after the debug session.

## Testing across host and container

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

## Trying agents without usage

`scripts/fake-claude.mjs` stands in for the `claude` CLI, so the autopilot, reviews, usage limits and resumes can be tried in the debug window in seconds and for free. In the debug window's settings, set `flotilla.agents.claudePath` to the absolute path of the script (executable: `chmod +x`). Its behaviour follows `fake:` lines in a ticket's description, such as `fake: wait 0s, changes`, `fake: ask`, `fake: limit 2m` or `fake: crash`; the script's header lists them all. Set the setting back to empty afterwards. An implementer run commits `fake-work/<id>.txt` on the item's branch, so point the fake only at a scratch item or branch, not at one you're keeping.

## File icons

`media/seti/` is a copy of VS Code's Seti icon theme plus a table of the built-in languages' file extensions, used when the user's icon theme isn't available where Flotilla runs (devcontainers). To refresh it from a newer VS Code: `node scripts/update-icons.mjs <path to a VS Code installation>`, e.g. `.vscode-test/vscode-linux-x64-<version>`.

## Releasing

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. `npm run typecheck && npm test && npm run build`
3. `npx vsce package` to try the `.vsix` locally (Extensions view → `…` → Install from VSIX…).
4. `npx vsce publish` (publisher `archipelagic`; `npx vsce login archipelagic` once, with an Azure DevOps token scoped to *Marketplace → Manage* and *All accessible organizations*).
