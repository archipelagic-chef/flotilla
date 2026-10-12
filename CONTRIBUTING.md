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

The devcontainer keeps its own `node_modules` in a Docker volume, so installing in the container never breaks the host's (and vice versa). It also installs the Claude Code extension; log in once inside the container and the login is kept in a volume across rebuilds.

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

`scripts/fake-claude.mjs` stands in for the `claude` CLI, so the autopilot, reviews, usage limits and resumes can be tried in the debug window in seconds and for free. In the debug window's settings, set `flotilla.agents.claudePath` to the absolute path of the script (executable: `chmod +x`). Its behaviour follows `fake:` lines in a ticket's description, such as `fake: wait 0s, changes`, `fake: ask`, `fake: limit 2m` or `fake: crash`; the script's header lists them all. Set the setting back to empty afterwards.

## File icons

`media/seti/` is a copy of VS Code's Seti icon theme plus a table of the built-in languages' file extensions, used when the user's icon theme isn't available where Flotilla runs (devcontainers). To refresh it from a newer VS Code: `node scripts/update-icons.mjs <path to a VS Code installation>`, e.g. `.vscode-test/vscode-linux-x64-<version>`.

## Releasing

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. `npm run typecheck && npm test && npm run build`
3. `npx vsce package` to try the `.vsix` locally (Extensions view → `…` → Install from VSIX…).
4. `npx vsce publish` (publisher `archipelagic`; `npx vsce login archipelagic` once, with an Azure DevOps token scoped to *Marketplace → Manage* and *All accessible organizations*).
