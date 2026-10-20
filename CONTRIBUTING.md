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

The playground's backlog and worktrees are seeded with every state Flotilla handles (To Do, an epic, a question from an agent, In Review with run blocks of each kind, approved, stopped, paused on a usage limit, Done; worktrees ahead, behind and with changes), by `scripts/playground-seed.mjs`. It takes the app's own entry keys, fingerprints, ticket format and review tests from `dist/playground-seed-kit.mjs`, which `npm run build` makes (`src/features/backlog/seedKit.ts`), so run that first. To seed it again, delete `.playground/.flotilla` and run `npm run playground`; worktrees that exist are kept.

An existing playground is never reset by F5; if it was built by an older version of `scripts/playground.mjs`, the task output says so. To start over, run `npm run playground -- --reset` or launch "Run Extension (fresh playground)". The old playground is moved to `.playground.old-<date>` (its worktrees move with it and keep working there, uncommitted changes included).
The CI/CD view needs GitHub's Actions API, which the test window reads from a fake one when it's offline: run `npm run fake-github` in a terminal (it stays up until Ctrl+C), and switch the fakes on in the debug profile (`npm run debug-profile -- --fakes`), which points the test window at it (`flotilla.dev.githubApi`, read only in the test window). Its branches get runs that move on by themselves, and the CI run fails in its tests with a realistic log; run again, it passes (as a flaky test would). The playground's `origin` is a local bare repository (in `.playground/.git/origin/`) whose path ends like GitHub's `playground/app`: approving a ticket pushes its branch there, never to github.com. With the fakes on, Flotilla pushes on approval only to a local `origin`.

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

## Demos

When a change is something you see or click (a button, a panel, a flow), its ticket shows it working: a demo is a short script of steps in `demos/<name>.json`, which `npm run demo` plays in an isolated VS Code and records as a GIF. The ticket's Run button plays the same steps again live, at the same pace, so you see what the GIF shows. The report's run block names the demo, with the player's command as its line:

````md
```run demo open-ticket
npm run demo -- play open-ticket
```
````

Flotilla plays `demos/open-ticket.json` and ignores the line, which is there for a Flotilla that doesn't know demo blocks: it runs the line as a shell command, with the same result.

```sh
npm run build
npm run demo -- record open-ticket --out .flotilla/backlog/BL-3/demo.gif --still .vscode-test/last.png
npm run demo -- play open-ticket    # live, in the window; it stays open until you close it
npm run demo -- list
```

The recorder refuses a build older than `src/` (it would play an old sidebar, whose elements the steps may not find): run `npm run build` again after a change.

The window is never yours: it's VS Code's test download (in the main worktree's `.vscode-test`, as `npm run test:vscode` uses), started with a profile of its own (`.vscode-test/demo-profile`), a home folder of its own (`.vscode-test/demo-home`: none of your git config, keys or VS Code's shared state), the fake Claude and a fake GitHub started for it, on this worktree's `.playground` (made if it's missing). Frames are screenshots of that window's page through its debugging port (playwright-core), never of the screen. Before a frame is kept, it's checked to come from that window: VS Code started with the demo profile, and the window's title, which only that profile sets (`Flotilla demo · …`). If a frame fails the check, nothing is saved, and the recorder says why. `--still` saves the last frame as a PNG, to check how the demo ends. One demo runs at a time in a worktree, as it holds that profile: a second one started there says so and waits for the first to finish (or its window to be closed); demos in other worktrees run alongside.

An agent's demos never open on your screen: when the recorder or player runs in an agent's command (Claude Code sets `CLAUDECODE` there, for agents Flotilla starts and any other), the window opens on a virtual display of its own, an Xvfb started for it on the first display from `:99` up with neither an X socket nor a lock (a dev container serves `:0`–`:2` without locks) and stopped when it's done. Frames are screenshots of the window's page either way, so the recording is the same size (1280 × 800) and quality. Played there, the window closes when the demo ends, as nobody sees it. Where Xvfb isn't installed, the demo says so and stops; it never falls back to your screen. `DEMO_DISPLAY=virtual` or `DEMO_DISPLAY=screen` chooses either way by hand (agents don't set it). Your run blocks play in a terminal of yours, so they show on your screen.

A demo of up to 15 s is a GIF (encoded in JavaScript with gifenc, at most 960 px wide). A longer demo is saved as an MP4 next to it, made with ffmpeg: the one on PATH, else the one the dev dependency `@ffmpeg-installer/ffmpeg` brings (a static build per platform, installed by `npm ci` from the npm registry), so no system ffmpeg is needed. Only when neither is there (say, `npm ci --omit=optional` or a platform it has no build for) does it stay a GIF, and the recorder says so. The ticket view shows GIFs as images and plays MP4s (`![What it shows](BL-3/demo.mp4)`).

A demo's steps each do one thing, in order. A step waits up to 15 s for what it needs (`"timeout"` changes that), and pauses a little after it, so that a viewer can follow:

| Step | What it does |
| --- | --- |
| `{ "command": "Focus on Flotilla View" }` | runs a command through the Command Palette, typed as a user would |
| `{ "click": "[aria-label=\"Backlog\"]" }` | moves the pointer to the first visible element the [Playwright selector](https://playwright.dev/docs/other-locators) finds, in the workbench or any webview (the sidebar, a ticket), and clicks it |
| `{ "hover": ".ci-run" }` | moves the pointer onto it and leaves it there, so what shows on hover (a row's actions) can be clicked next |
| `{ "type": "BL-3" }` / `{ "press": "Enter" }` | types text, presses a key (`Control+Enter`, `Escape`…) |
| `{ "waitFor": "h1:has-text(\"Sort\")" }` | waits until a selector finds something visible |
| `{ "wait": 1500 }` | waits that many milliseconds (to let a result be seen) |
| `{ "caption": "A click on a card opens its ticket" }` | shows a caption at the bottom; `""` removes it |

The example, [demos/open-ticket.json](demos/open-ticket.json), opens a ticket from the backlog:

```json
{
  "title": "Open a ticket from the backlog",
  "steps": [
    { "command": "Focus on Flotilla View" },
    { "caption": "The backlog: the playground's tickets" },
    { "click": "[aria-label=\"Backlog\"]" },
    { "wait": 1200 },
    { "caption": "A click on a card opens its ticket" },
    { "click": ".backlog-item:has-text(\"Sort the backlog by priority\")" },
    { "waitFor": "h1:has-text(\"Sort the backlog by priority\")" },
    { "wait": 2000 },
    { "caption": "" }
  ]
}
```

A demo can set Flotilla's own settings it plays with, next to its steps: `"settings": { "flotilla.merge.checks": "local" }` (the merge demos of the local checks do, as the playground's BL-13 has CI). They last for that demo only.

Keep a demo short, and safe to play again: a demo that changes the playground (creates a worktree, say) finds it changed the next time, so prefer selectors that still match, or reset the playground first (`npm run playground -- --reset`). When you run it, the window pops up on your screen while it records or plays.

## File icons

`media/seti/` is a copy of VS Code's Seti icon theme plus a table of the built-in languages' file extensions, used when the user's icon theme isn't available where Flotilla runs (devcontainers). To refresh it from a newer VS Code: `node scripts/update-icons.mjs <path to a VS Code installation>`, e.g. `.vscode-test/vscode-linux-x64-<version>`.

## Releasing

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. `npm run typecheck && npm test && npm run build`
3. `npx vsce package` to try the `.vsix` locally (Extensions view → `…` → Install from VSIX…).
4. `npx vsce publish` (publisher `archipelagic`; `npx vsce login archipelagic` once, with an Azure DevOps token scoped to *Marketplace → Manage* and *All accessible organizations*).
