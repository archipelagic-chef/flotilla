# Contributing to Flotilla

## Development

Open the folder in the devcontainer (or on the host with Node 22 and git), then:

```bash
npm ci
npm test               # unit + git integration tests (vitest), queued with the other worktrees' runs
npm run test:related   # only the tests of what changed since main
npm run typecheck
npm run build
npm run format         # Prettier; the pre-commit hook does it for the staged files
xvfb-run -a npm run test:vscode   # in the container; plain `npm run test:vscode` on a desktop
docker build -f test/docker/old-git.Dockerfile -t flotilla-oldgit . && docker run --rm flotilla-oldgit
```

`npm test` (`scripts/test.mjs`) shares the machine with the test runs of the repository's other worktrees: a full run waits for one of `flotilla.checks.maxParallel` slots (by default 1 per 16 cores; `FLOTILLA_CHECKS_MAX_PARALLEL` overrides it) and runs vitest with its share of the cores. A merge's checks go first. Runs given files (`npm test -- tests/unit/foo.test.ts`) don't wait. While you work, run `npm run test:related`: `vitest related` on the files changed since the merge base with main (committed, not committed and new), so only the tests that import them run, without waiting; a change to `tests/helpers/`, `vitest.config.ts`, `package.json`, the lockfile or a tsconfig runs the full suite instead (queued). A single file with `npx vitest run <file>` is enough when you know which. Run the full `npm test` once, before "Ready for review" (the merge's checks run it again).

Each vitest run gets a temp folder of its own, `<tmp>/flotilla-tests/run-<pid>-…` ([tests/helpers/tempRoot.ts](tests/helpers/tempRoot.ts)): the workers see it as the system temp folder (`TMPDIR`, `TMP`, `TEMP`), so what the tests and the code under test make there (`makeTempDir`, `os.tmpdir()`) is removed with it when the run ends, also when tests fail or time out. The folders of runs that were killed are removed when the next run starts.

The merge flow (Merge to main, the merge train, Resolve and Fix with Agent, Approve, Cancel) has scenario tests in `tests/integration/merge/`: whole sequences of clicks on a real repository, with scripted agents (resolve, fix, commit nothing, redo the merge, crash, or work later) and checks (pass, fail, time out), and main moved by another merge when a scenario says. Each step records the ticket's merge state and what it offers to click next (`mergeActions`, which the ticket's buttons use too), and fails if a step leaves it where an earlier one did: a loop. The states and what moves each are in the table at the top of `src/features/backlog/mergeStates.ts`. A new path goes into that table and into a scenario together; a sequence that broke becomes a scenario as it happened.


The devcontainer keeps its own `node_modules` in a Docker volume, so installing in the container never breaks the host's (and vice versa). It also installs the Claude Code extension; log in once inside the container and the login is kept in a volume across rebuilds.

## The playground

Press F5 ("Run Extension (playground)") to launch an Extension Development Host opened on `.playground/`, a throwaway repo that `npm run playground` (`scripts/playground.mjs`) creates on first launch. Run `npm run build` first: the seeding below needs it. Everything Flotilla does can be tried there by hand, in seconds, without touching your own repositories or using any usage.

What's in it:

- **A small project worth running** (from `scripts/playground-app/`, plain Node, nothing to install): a CLI, a server and tests, with a launch configuration ("Run App") and tasks ("test", "serve"), so the run blocks of a review have something to start. The branch `feature/greeting-without-comma` has a failing test.
- **Tickets and worktrees in every state** Flotilla handles (To Do, an epic, a question from an agent, In Review with run blocks of each kind, approved, stopped, paused on a usage limit, Done; worktrees ahead, behind and with changes), seeded by `scripts/playground-seed.mjs`. It takes the app's own entry keys, fingerprints, ticket format and review tests from `dist/playground-seed-kit.mjs`, which `npm run build` makes (`src/features/backlog/seedKit.ts`). To seed it again, delete `.playground/.flotilla` and run `npm run playground`; worktrees that exist are kept.
- **A local `origin`**: a bare repository in `.playground/.git/origin/`, whose path ends like GitHub's `playground/app`. Approving a ticket pushes its branch there, never to github.com.

An existing playground is never reset by F5; if it was built by an older version of `scripts/playground.mjs`, the task output says so. To start over, run `npm run playground -- --reset` or launch "Run Extension (fresh playground)". The old playground is moved to `.playground.old-<date>` (its worktrees move with it and keep working there, uncommitted changes included).

The fakes stand in for Claude and GitHub, so agents and the CI/CD view can be tried for free and offline. They're off by default; switch them on with `npm run debug-profile -- --fakes` (see [The debug window's profile](#the-debug-windows-profile)):

- **Claude** (`scripts/fake-claude.mjs`): agents answer in seconds, as a ticket's `fake:` lines say (see [Trying agents without usage](#trying-agents-without-usage)).
- **GitHub** (`scripts/fake-github.mjs`): run `npm run fake-github` in a terminal (it stays up until Ctrl+C). It serves the Actions API the CI/CD view reads (`flotilla.dev.githubApi`, read only in the test window). Its branches get runs that move on by themselves, and the CI run fails in its tests with a realistic log; run again, it passes (as a flaky test would). With the fakes on, Flotilla pushes on approval only to a local `origin`.

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

`scripts/fake-claude.mjs` stands in for the `claude` CLI, so the autopilot, reviews, usage limits and resumes can be tried in the debug window in seconds and for free. `npm run debug-profile -- --fakes` points the debug window's `flotilla.agents.claudePath` at it. Its behaviour follows `fake:` lines in a ticket's description, such as `fake: wait 0s, changes`, `fake: ask`, `fake: limit 2m` or `fake: crash`; the script's header lists them all. `npm run debug-profile -- --no-fakes` switches back to the real one. An implementer run commits `fake-work/<id>.txt` on the item's branch, so point the fake only at a scratch item or branch, not at one you're keeping.

## Where a part goes

The views are split into one file per part, so two tickets that change different parts change different files, and
their merges don't conflict. Add to the part's file, or give a new part a file of its own; keep the entry files small.

- **The ticket view** ([src/webview/ticket/](src/webview/ticket/)): [main.tsx](src/webview/ticket/main.tsx) is the app
  shell (the messages from the host, the layout of the sections) only. Each section is a module: `header.tsx`,
  `description.tsx`, `stateCard.tsx`, `ask.tsx`, `work.tsx`, `agents.tsx`, `reviewPanel.tsx`, `mergePanel.tsx`,
  `activity.tsx` (the feed and the comment box), `attachments.tsx`, `demo.tsx`, `ci.tsx`. What sections share is in its
  own: `actions.tsx` (`send`, `act`, `useWorking`, `ActionButton`, `Dropdown`), `comments.tsx` (sending a comment,
  replying), `markdownBox.tsx` (the Markdown editor and `Rendered`). A new section is a new module, which `main.tsx`
  places.
- **The ticket tab's host** ([src/ui/backlog/ticketPanel.ts](src/ui/backlog/ticketPanel.ts)) builds the view; the
  webview's messages are handled in [src/ui/backlog/ticketMessages/](src/ui/backlog/ticketMessages/), one module per
  group (`ticket`, `comments`, `files`, `tracker`, `agents`, `review`, `merge`, `check`), each a map of handlers by
  message type. A new message type is declared in its group's `<group>.messages.ts` and handled in its `<group>.ts`
  (the typecheck fails until it is); a new group gets both files, and a line in `index.ts` and in
  `HandledTicketMessage` ([src/webview/ticketProtocol.ts](src/webview/ticketProtocol.ts)). The panel only dispatches.
- **The backlog view** ([src/webview/ui/backlog.tsx](src/webview/ui/backlog.tsx)) is the lanes and their drag and drop;
  the cards are in `card.tsx`, the title bar in `titleBar.tsx`, the autopilot's bar in `autopilotBar.tsx`, Needs You in
  `needsYou.tsx` and the merge queue in `mergeQueueBar.tsx`.
  A card is Compact by default (`flotilla.backlog.cards`, BL-183): its title, one status line and its next step, all
  from `cardStatus()` ([src/features/backlog/cardStatus.ts](src/features/backlog/cardStatus.ts)), with its tests in
  `tests/unit/features/cardStatus.test.ts`. A new state of a ticket gets its line (and its mark, if it needs you) there;
  a new detail or action goes in the hover row (`CompactCard`) and in Detailed. A demo that shows a Detailed-only sign
  sets `"settings": { "flotilla.backlog.cards": "detailed" }`.
- **Commands** (BL-185): each feature's module exports its commands as a map of handlers by command id
  (`Commands`, [src/ui/commandSet.ts](src/ui/commandSet.ts)), made from the deps it's given:
  `mergeCommands` ([src/ui/backlog/mergeCommands.ts](src/ui/backlog/mergeCommands.ts)), `agentCommands`,
  `autopilotCommands`, `metricsCommands`, `viewCommands` (the sidebar's), `activeWorktreeCommands`, `hygieneCommands`.
  [src/extension.ts](src/extension.ts) only makes the deps and calls `registerAll(context.subscriptions, xCommands(…))`
  once per feature; it registers no command itself. The worktree commands of [src/ui/commands.ts](src/ui/commands.ts)
  (they report errors with Show Output) are split the same way: `registerCommands` joins `worktreeCommands`,
  `backlogCommands`, `ciCommands`, `scmCommands` ([src/ui/scmCommands.ts](src/ui/scmCommands.ts)) and `chatCommands`
  ([src/ui/chatCommands.ts](src/ui/chatCommands.ts)). A new command goes in its feature's map, next to its
  `package.json` entry; a new feature's map also goes in the list of
  [tests/unit/ui/commandSet.test.ts](tests/unit/ui/commandSet.test.ts), which checks that every command of
  `package.json` is registered, once.
- **A part's CSS** is in its own file next to it (`card.tsx` → `card.css`), which the part imports
  (`import './card.css';`); esbuild bundles it into `dist/webview.css` or `dist/ticket.css`. Only what parts share
  (the variables, `body`, buttons, rows, `.rendered`, the layout) stays in the entry CSS, `ui/styles.css` or
  `ticket/ticket.css`, which the entry imports before the parts, so a part's rules come after the shared ones and win
  at the same specificity.

## Additions that merge cleanly

Most merge conflicts here were two tickets adding unrelated lines at the same spot, usually the end of a list (BL-155).
So:

- **One format.** Prettier ([.prettierrc.json](.prettierrc.json): 160 wide, single quotes) formats the code, TypeScript,
  JavaScript and CSS; Markdown and `package.json` keep theirs. `npm install` installs a pre-commit hook
  ([scripts/install-hooks.mjs](scripts/install-hooks.mjs)) that formats the staged files, in every worktree, and
  `npm test` fails on a file that isn't formatted (`npm run format` fixes it). Don't reformat what you don't change.
- **Imports.** An import of four names or more lists them one per line, sorted
  ([scripts/prettier-imports.mjs](scripts/prettier-imports.mjs) does it), so two added names land on different lines.
  Keep it that way when you add one: Prettier puts it in its place.
- **Ticket tab messages**: in their group's files, as in "Where a part goes" above.
- **Settings and commands in `package.json`**: next to the related ones of the same feature, not at the end of the list.
- **`CHANGELOG.md`**: one entry per ticket under "## Unreleased". It merges with `merge=union`
  ([.gitattributes](.gitattributes)), which keeps both sides' lines: add a new paragraph rather than editing another
  ticket's, so the merge doesn't keep two versions of it.
- **CSS**: with the rules of the part it styles, not at the end of the file.
- **Splitting an epic**: siblings that build the same part get `Depends on:` the earlier one, so they don't build it in
  parallel and conflict; siblings in separate parts run in parallel.

### Merging main past the reformat

The commit that formatted the whole repository (`4da0391`, listed in [.git-blame-ignore-revs](.git-blame-ignore-revs),
which `git config blame.ignoreRevsFile .git-blame-ignore-revs` makes `git blame` skip) changes most lines of most
files, so a branch from before it conflicts all over when it merges main. Merge main in three steps instead:

```bash
git merge 4da0391^                       # main up to the reformat: your usual conflicts, if any
npm ci && npm run format && git commit -am "BL-…: Format as main does"
git merge -s ours 4da0391 && git merge main
```

Your branch, formatted, is what the reformat would have made of it, so `-s ours` takes it as it is.

## Buttons that wait

A button that starts something taking a while (git, GitHub, an agent starting, a file write and the backlog's refresh) says it's working from the click until the host is done, and takes no second click meanwhile (BL-116). The webview marks the action busy when it sends it; the host replies "done" for every such message, in a `finally`, whether the action posted, failed (`failed: true`; the error shows as before), was cancelled at a question or returned early. So nothing sticks, and a button whose action asks first (a confirmation, a quick pick) stays working while the question is up.

- **The ticket view**: use `ActionButton` with the message (`working="Merging…"` for a label of its own; "Working…" by default), or call `act(message, label)` from a button of your own and read `useWorking(message)` ([src/webview/ticket/actions.tsx](src/webview/ticket/actions.tsx)). The host's `{ type: 'done' }` is posted for every message ([src/ui/backlog/ticketPanel.ts](src/ui/backlog/ticketPanel.ts)). Two clicks are the same action when `actionKey` ([src/webview/ticketActions.ts](src/webview/ticketActions.ts)) gives them the same key: give a new message type a case there when it carries a target (a hash, a key, a verdict), so one item's busy button doesn't disable another's.
- **The sidebar's backlog**: use `BusyButton` with the `backlog` message and its codicon (it spins while working), or `act(message)` and `useBusy().has(message)` ([src/webview/ui/backlogBusy.tsx](src/webview/ui/backlogBusy.tsx)). The sidebar posts `backlogDone` for every `backlog` message ([src/ui/sidebar/sidebarProvider.ts](src/ui/sidebar/sidebarProvider.ts)); `backlogActionKey` ([src/webview/backlogActions.ts](src/webview/backlogActions.ts)) keys them by op and item, and an item's busy actions end when it leaves the backlog.
- **Other sidebar messages**: a message that has no done reply yet gets one the same way: the host posts it in a `finally` around the handler, with the message as it was sent, and the webview clears the busy state on it. Don't rely on the tool icon's spinner (`trackProgress`): it isn't where the user clicked.

Test it as `tests/unit/webview/backlogActions.test.ts` does (a second start of the same action is refused; finishing, failing and pruning clear it), and show it in the ticket's demo, as `demos/backlog-busy.json` does: a caption right after the click, while the button is still working.

## Events

What happens to tickets, agents and merges is recorded as events (BL-157), one JSON object per line in `.git/flotilla/metrics/events-YYYY-MM.jsonl` of the main repository (never committed): `at`, `kind`, `ticket`, `agent`, `data`. The metrics are counted from them, so a question about how Flotilla works ("how often do merges conflict, and where?") is a count, not a replay script.

- **To record something**, call `recordEvent(kind, { ticket, agent, data })` ([src/features/metrics/events.ts](src/features/metrics/events.ts)) where it happens. It isn't awaited and never throws: recording doesn't slow or break the step it records. A new kind goes into `EventData` there, with the shape of its `data`, and gets a sample in `tests/unit/features/metrics/events.test.ts` (it doesn't compile without one). Scripts record with `recordEvent(commonDir, kind, …)` of `scripts/record-event.mjs`.
- **The history** before the log (the tickets' activity notes and the merges replayed from git) is read in once by the leading window, marked `imported` ([src/features/metrics/import.ts](src/features/metrics/import.ts)). A note whose wording changes should still be read there.
- **The Metrics view** (BL-158: the sidebar's Metrics tool, and *Flotilla: Open Metrics* in an editor tab) counts them in the host: [src/features/metrics/compute.ts](src/features/metrics/compute.ts) turns the log into its numbers and charts for a period and the one before (pure, tested on a fixed log in `tests/unit/features/metrics/compute.test.ts`), and [src/features/metrics/store.ts](src/features/metrics/store.ts) reads only what was appended since its last look. A new number goes into `computeMetrics`, with its rows (what it's made of) and its `empty` line. The playground has a month of events to show (`seedEvents` in `scripts/playground-seed.mjs`, written again before every demo). Its first section, Productivity (BL-189), reads `agent-spend` events: [src/features/metrics/transcriptSpend.ts](src/features/metrics/transcriptSpend.ts) splits a chat's transcript by the prompt that started each part (first pass, review, rework, main, resume, answer, orchestration) and shares its cost records among them, and [src/features/metrics/spendScan.ts](src/features/metrics/spendScan.ts) records what's new every 5 minutes in the leading window (the history imported once, its place kept in `spend-scan.json` next to the events). A new Flotilla prompt gets its purpose in `PROMPTS` there, tested in `tests/unit/features/metrics/transcriptSpend.test.ts`.
- **After 12 months** a month's events are rolled up into `totals-YYYY-MM.json` ([src/features/metrics/rollup.ts](src/features/metrics/rollup.ts)).
- **The improvement review** (BL-159) gives its agent the metrics of [src/features/metrics/summary.ts](src/features/metrics/summary.ts), each with a stable id, this period next to the one before. A proposal's `Improves: <id> from X to Y` line names one, and the next review counts it before and after the ticket landed ([src/features/metrics/improves.ts](src/features/metrics/improves.ts)). A new metric is a `metricDefs` entry there (keep the ids: merged tickets name them). The reviews are `.flotilla/backlog/reviews/YYYY-MM-DD.md`.

## Demos

When a change is something you see or click (a button, a panel, a flow), its ticket shows it working: a demo is a short script of steps in `demos/<name>.json`, which `npm run demo` plays in an isolated VS Code and records as a GIF. The ticket's Run button plays the same steps again live, at the same pace, so you see what the GIF shows. The report's run block names the demo, with the player's command as its line:

````md
```run demo open-ticket
npm run demo -- play open-ticket
```
````

Flotilla plays `demos/open-ticket.json` and ignores the line, which is there for a Flotilla that doesn't know demo blocks: it runs the line as a shell command, with the same result.

The ticket shows the recording and its block as one demo: "Recorded demo · 0:12" over the recording, with **Try it yourself** (`npm run demo -- try <name>`: the demo's window as it starts, its steps left to you) and **Watch it live** (`play`), in the report, the Demo section and the Attachments viewer alike; the block isn't shown again below it. The recorder notes the demo's name in what it records (`flotilla-demo:<name>`, in the GIF's or MP4's comment), so a recording goes with its block wherever the report puts them. Once the ticket's worktree is gone (merged and cleaned up), they run from the main worktree when the demo is there.

Write the demo, check it, and record it once: `check` plays the steps fast, without recording or pauses, and prints each step's result, so a wrong selector costs seconds, not a recording. Record when it passes, at the end of the work, and don't record again unless the work changed since.

```sh
npm run demo -- check open-ticket   # the dry run: each step's result, and what failed
npm run demo -- record open-ticket --out .flotilla/backlog/BL-3/demo.gif --still .vscode-test/last.png
npm run demo -- play open-ticket    # live, in the window; it stays open until you close it
npm run demo -- try open-ticket     # its window as the demo starts, its steps left to you (Try it yourself)
npm run demo -- list
```

Before it starts, the recorder makes ready what it needs: it builds (`npm run build`) when `dist/` is older than `src/` (an old build plays an old sidebar, whose elements the steps may not find), and reads the demo profile's `settings.json` as JSON with comments, moving a broken one aside (`settings.json.broken`) to start afresh. Each demo starts from the same window: what the last one left in the profile's workspace storage (the sidebar's state, a fold left open, the views and editors open) is cleared first, so a toggle a demo clicks goes the same way every run. A step that fails saves a screenshot of the window next to the demo (`demos/<name>.failed.png`, ignored by git, gone once it passes) and prints the visible elements most like what it looked for, their labels and text: `[aria-label="Backlogs"]` lists `button aria-label="Backlog"`. A `command` step whose command the palette doesn't have fails there, rather than running one of the "similar commands" it offers. The last line says how it went, for an agent to read: `Demo saved: <file> (<size>, <length>)`, `Demo checked: all <n> steps passed`, or `Demo failed: step <n> (…): <why> (screenshot: <file>)`. Checks and failures are events too (`demo-checked`, `demo-failed`), next to `demo-recorded`.

The window is never yours: it's VS Code's test download (in the main worktree's `.vscode-test`, as `npm run test:vscode` uses), started with a profile of its own (`.vscode-test/demo-profile`), a home folder of its own (`.vscode-test/demo-home`: none of your git config, keys or VS Code's shared state), the fake Claude and a fake GitHub started for it, on this worktree's `.playground` (made if it's missing). Frames are that window's page as Chromium draws it: its screencast through the debugging port (playwright-core), never the screen. Each frame comes when the page changes, with the time it was drawn, and the recording keeps 25 a second, so the pointer glides rather than jumps, also when the machine is busy. Recording starts once the window is ready: the workbench shown, Flotilla's view in the activity bar, Flotilla's status bar item (there once the extension has started, so its commands are), and nothing changed on screen for a second (a window that doesn't settle within a minute fails the demo). A frame is kept only once a check after it finds that window: VS Code started with the demo profile, and the window's title, which only that profile sets (`Flotilla demo · …`), checked four times a second. If a check fails, nothing is saved, and the recorder says why. A GIF holds only what changed from one frame to the next, so a 15 s demo stays well under 2 MB; a longer one becomes an MP4 at 25 fps. Recording prints how far apart the frames were while the pointer moved (the `pointer-sweep` demo is there to measure it). `--still` saves the last frame as a PNG, to check how the demo ends. One demo runs at a time in a worktree, as it holds that profile: a second one started there says so and waits for the first to finish (or its window to be closed); demos in other worktrees run alongside.

An agent's demos never open on your screen: when the recorder or player runs in an agent's command (Claude Code sets `CLAUDECODE` there, for agents Flotilla starts and any other), the window opens on a virtual display of its own, an Xvfb started for it on the first display from `:99` up with neither an X socket nor a lock (a dev container serves `:0`–`:2` without locks) and stopped when it's done. Frames are the window's page either way, so the recording is the same size (1280 × 800) and quality. Played there, the window closes when the demo ends, as nobody sees it. Where Xvfb isn't installed, the demo says so and stops; it never falls back to your screen. `DEMO_DISPLAY=virtual` or `DEMO_DISPLAY=screen` chooses either way by hand (agents don't set it). Your run blocks play in a terminal of yours, so they show on your screen.

A demo of up to 15 s is a GIF (encoded in JavaScript with gifenc, at most 960 px wide). A longer demo is saved as an MP4 next to it, made with ffmpeg: the one on PATH, else the one the dev dependency `@ffmpeg-installer/ffmpeg` brings (a static build per platform, installed by `npm ci` from the npm registry), so no system ffmpeg is needed. Only when neither is there (say, `npm ci --omit=optional` or a platform it has no build for) does it stay a GIF, and the recorder says so. The ticket view shows GIFs as images and plays MP4s (`![What it shows](BL-3/demo.mp4)`).

A demo's steps each do one thing, in order. A step waits up to 15 s for what it needs (`"timeout"` changes that), and pauses a little after it, so that a viewer can follow:

| Step | What it does |
| --- | --- |
| `{ "command": "Focus on Flotilla View" }` | runs a command through the Command Palette, typed as a user would |
| `{ "click": "[aria-label=\"Backlog\"]" }` | moves the pointer to the first visible element the [Playwright selector](https://playwright.dev/docs/other-locators) finds, in the workbench or any webview (the sidebar, a ticket), and clicks it |
| `{ "hover": ".ci-run" }` | moves the pointer onto it and leaves it there, so what shows on hover (a row's actions) can be clicked next |
| `{ "drag": "text=BL-2", "to": "text=BL-1" }` | drags the first element onto the second (both in the same webview), as a mouse would |
| `{ "type": "BL-3" }` / `{ "press": "Enter" }` | types text, presses a key (`Control+Enter`, `Escape`…) |
| `{ "waitFor": "h1:has-text(\"Sort\")" }` | waits until a selector finds something visible |
| `{ "wait": 1500 }` | waits that many milliseconds (to let a result be seen) |
| `{ "caption": "A click on a card opens its ticket" }` | shows a caption at the bottom; `""` removes it |
| `{ "agentTurn": "Vega-2" }` | the seeded agent's chat goes on by a turn: its transcript grows, as a running agent's does (the value names it, for the reader) |

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

The demo window has chats to open: every demo starts by seeding them (`seedChats` in `scripts/playground-seed.mjs`), in BL-3's worktree, with their transcripts in the demo home's `.claude/projects`: an agent's (Vega-2, `claude -p`, working: it opens read-only, as [demos/open-agent-chat.json](demos/open-agent-chat.json) shows), a panel chat (done), and an agent's that shows as working though nothing runs it (Orbit-2, its process ended 7 minutes before: a Check finds it, as [demos/check-ticket.json](demos/check-ticket.json) shows). The F5 window uses your own `~/.claude`, so `npm run playground` doesn't write them there.

Keep a demo short, and safe to play again: a demo that changes the playground (creates a worktree, say) finds it changed the next time, so prefer selectors that still match, or reset the playground first (`npm run playground -- --reset`). When you run it, the window pops up on your screen while it records or plays.

## File icons

`media/seti/` is a copy of VS Code's Seti icon theme plus a table of the built-in languages' file extensions, used when the user's icon theme isn't available where Flotilla runs (devcontainers). To refresh it from a newer VS Code: `node scripts/update-icons.mjs <path to a VS Code installation>`, e.g. `.vscode-test/vscode-linux-x64-<version>`.

## Releasing

1. Move the entries under "## Unreleased" to the new version's heading, and bump `version` in `package.json`.
2. `npm run typecheck && npm test && npm run build`
3. `npm run package` to try the `.vsix` locally (Extensions view → `…` → Install from VSIX…). It packages a copy of
   `dist/`, `media/` and the manifest in the temp folder (`scripts/package.mjs`): `vsce package` run in the repository
   walks every agent worktree under `.worktrees/` and doesn't finish. The build records its commit in
   `dist/build.json`; in this repository, the status bar counts what main has merged since, and its click ("Flotilla:
   Install Main and Reload") builds main the same way in a throwaway worktree, pauses the agents (Pause All), installs
   it and reloads; the new build resumes them from a note in `.git/flotilla/install-main.json`, and other windows of the
   repository reload too.
4. `npx vsce publish --packagePath flotilla-<version>.vsix` (publisher `archipelagic`; `npx vsce login archipelagic` once, with an Azure DevOps token scoped to *Marketplace → Manage* and *All accessible organizations*).
