# Flotilla

Work on several branches at once, each in its own git worktree, from one VS Code window: files, search, version control and Claude Code chats per worktree, and a view of which worktree needs you. Works on Windows, Linux and macOS hosts **and** in devcontainers, including a host window and a container window open on the same repository at the same time.

Flotilla doesn't replace Claude Code or any other agent. Your chats run in Claude Code as usual; Flotilla links each one to its worktree and shows whether it is working, waiting for you or finished. Its **backlog** keeps the work as tickets, which agents pick up, report in and hand over for review.

> **Preview:** Flotilla is young and changes quickly. Feedback and bug reports are welcome on [GitHub](https://github.com/archipelagic-chef/flotilla/issues).

## Features

Flotilla is meant to be your sidebar. **Worktree tabs** run across its top, like editor tabs: the first, **All**, shows every worktree at once; the others show one worktree each. The selected tab is the window's **active worktree**: Ctrl+P lists its files, commands from the palette act on it, new terminals (*Flotilla: New Terminal in Active Worktree*) start in it, the status bar shows it, and Ctrl+Alt+0…9 switch it (0 is All). Each tab shows the worktree's ticket id (`ABC-123`, `#123`) or short name, its color, a dot for its most urgent chat state and its open chats. Close tabs you don't need (×, middle-click or right-click); the worktree stays in the Overview, and opening it there reopens its tab.

A **tool strip** runs down its left side:

- **Overview**: every worktree, most urgent first, with its status, changes, sync state and the question a chat is waiting on. Double-click one to open it; remove worktrees from here or from a tab's context menu.
- **Files**: the file tree with your file icon theme (or VS Code's Seti, in a devcontainer where your theme isn't installed), git change badges, git-ignored files greyed out, reveal of the active editor's file, new file and folder (inline, `a/b/c.ts` creates the folders), rename (F2), delete to the Trash (Delete), cut/copy/paste (also between worktrees) and drag and drop.
- **Search**: text search and replace in the active worktree (or all of them on the All tab), with match case, whole word and regex. It searches tracked and untracked files and skips ignored ones.
- **Version Control**: like VS Code's Source Control, per worktree: a message box with Commit (and Commit & Push, Commit & Sync, Amend), Publish Branch or Sync Changes, and staged and unstaged changes with stage, unstage and discard.
- **Backlog**: tickets in To Do, In Progress, In Review, Ready to Merge and Done (see below). Each card says whether its work is merged into the base branch (from git).
- **Chats**: the Claude Code chats linked to the worktree, with their state (working, waiting for you, finished), *New chat* and the history of every chat linked to it. Its icon counts the chats waiting for you (an approval, or output to reply to).

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

## Backlog and agents

The **Backlog** keeps the repository's work as tickets, in `.flotilla/backlog/` in the main worktree (kept out of git): `backlog.json` for the order and status, and a Markdown file per ticket with its description and its activity. A ticket opens in an editor tab, with its status, priority, worktrees, commits, the agents that worked on it, and an activity feed of comments, agents' reports and everything that changed.

- **Agents on tickets**: *Start an Agent* opens a Claude Code chat in the ticket's worktree (created if needed). Agents report in the ticket, start commit messages with its id (a commit-msg hook checks it), keep its description up to date, ask when they need you, and end with "Ready for review." Pick each ticket's model and effort; with one chosen, the agent runs as a Claude Code session in a terminal.
- **Ask, off the record**: the *Ask* pane in a ticket (folded until you open it) answers quick questions about it ("what's this for?", "how far is it?", "which files does it touch?") in a small chat. A lightweight agent (`flotilla.ask.model`, default Sonnet) answers from the ticket and its branch, reading the code and git only. Nothing is written to the ticket and agents don't see it; follow-ups go on in the same chat until you close the ticket or start a *New Question*. *Post to Ticket* adds an answer worth keeping as your comment. It doesn't count against `flotilla.agents.maxRunning`, but waits while memory is short.
- **Any chat works through the backlog**: chats learn about it from `AGENTS.md` next to it, claim or add tickets through its inbox, and can split work into sub-tickets (as proposals you accept, or straight in: `flotilla.backlog.agentTickets`).
- **Reviews**: a reviewer agent reviews work in review and gives a verdict; requested changes go back to the implementer. Review it yourself with *Approve* and *Request Changes*; the agent picks your changes up, asking first if it needs to. A stopped review offers the fixes for why it stopped.
- **Merge to main**: an approved ticket (Ready to Merge) merges from its ticket (or its card's right-click menu, which also has *Merge All Ready Tickets*, dependencies first). Flotilla merges in a temporary worktree (`git merge --no-ff`, "Merge BL-12: <title>"), so none of your worktrees is left mid-merge; it refuses a branch carrying unfinished tickets' commits and says when a ticket looks superseded. It runs the checks (`flotilla.merge.checkCommand`) in a terminal, and only when they pass moves the base branch to the merge and the ticket to Done. Conflicts: an agent resolves them, keeping both sides' intent, for you to approve; or cancel. Nothing is pushed until you click *Push*.
- **Autopilot** (the rocket in the backlog's title): agents take To Do tickets from the top and work on them without a window, up to `flotilla.agents.maxRunning` agents at once, shared with the reviews. Starts Flotilla makes on its own wait in a queue when that's reached: your replies to an agent first, then reviews and revisions, then resumes, then new tickets. **Prioritize** (in a ticket's queued note, or in Needs you) starts a queued start now, above the limit, up to `flotilla.agents.maxPrioritized` extra agents; at that ceiling it asks which running agent to pause for it. An agent that hits Claude's usage limit is paused, and goes on by itself when the limit resets.
- **Current with main**: when main moves, each open ticket's branch is merged with it in memory (no worktree touched); one that would conflict says "conflicts with main" on its card and in its ticket, while its agent is still around. *Update from Main* in the ticket merges main into the branch, or has the ticket's agent do it when that conflicts. Agents merge main and run the checks before "Ready for review.", never merge other tickets' branches, and write "Depends on: BL-12" in the description when they need another ticket's work: the ticket then waits for it (the autopilot doesn't start it).
- **Pause, Resume and Stop** any agent on a ticket (the implementer, the reviewer, the discussion's agent; without a window or in a terminal), from its *Agents* row, the ticket's status card, or the backlog card's right-click menu. *Pause* ends it now and keeps its chat and its uncommitted work; *Resume* goes on in the same chat, which checks `git status` first. A paused agent frees its slot (`flotilla.agents.maxRunning`), and nothing resumes it but you. A stopped agent offers *Resume* or *New Agent*. An agent in a terminal is ended through its terminal's process; one in Claude Code's panel can only be stopped there (the ticket offers to open its chat).
- **History clean-up**: rewrite a ticket's branch into a few clean commits (an agent with you, or yourself); the old history is kept under `refs/flotilla/history/`.
- **Merged or not**: a ticket's branches are read from git against the base branch (`flotilla.defaultBase`, or the remote's default). Work in review that's merged moves to Done by itself, also when the merge is done on the command line. A Done ticket with unmerged work says so, and offers to merge it (as a sibling ticket), dismiss it as superseded by another ticket, or open its branch.
- **Jira and GitHub Issues**: list their issues in the backlog, link local tickets to them, and post comments, change status and priority, or create issues from a ticket. Every write asks you first; agents are told never to change trackers.

Agents Flotilla starts without a window (the autopilot's, reviewers, and those making requested changes) run the Claude Code CLI with `flotilla.agents.permissionMode` (default `auto`): nobody is there to approve a request, so what that mode doesn't allow is refused. Choose it with care, especially `bypassPermissions`.

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
| `flotilla.linkFolders` | `[]` | Folders (e.g. `node_modules`) a new worktree gets as hard links to the main worktree's: no extra space |
| `flotilla.removeFinishedWorktrees` | `auto` | Remove a done ticket's worktree when nothing in it can be lost (`ask`, `off`); its branch is kept |
| `flotilla.autoAdopt` | `true` | Make in-repo worktrees portable automatically |
| `flotilla.defaultBase` | `""` | Base branch for progress and compare |
| `flotilla.activeWindowMinutes` | `5` | Activity → active threshold |
| `flotilla.staleAfterDays` | `7` | Activity → stale threshold |
| `flotilla.agentStatusStaleMinutes` | `10` | When a `working` report is considered stale |
| `flotilla.notify` | `needsYou` | Notifications for what needs you: `needsYou` (one a minute, gathered), `all` (each as it happens), or `off` |
| `flotilla.ci.notify` | `failures` | Notify when a CI run on a worktree's branch finishes: `failures`, `all` or `off` |
| `flotilla.pollSeconds` | `15` | Refresh interval for worktrees in use while the view is visible; other worktrees every few minutes |
| `flotilla.tagChatTitles` | `true` | Rename linked chats to "<branch>: <title>" in Claude Code's session list |
| `flotilla.tabLabelPattern` | `""` | Regular expression for the id shown on worktree tabs (default: Jira keys and issue numbers) |
| `flotilla.backlog.commitPrefix` | `agents` | Whose commits in a ticket's worktree must start with its id: `agents`, `everyone` or `off` |
| `flotilla.backlog.agentTickets` | `propose` | Whether tickets agents add wait for you to accept them, or join the backlog at once |
| `flotilla.review.automatic` | `true` | A reviewer agent reviews work that goes to review |
| `flotilla.review.maxRounds` | `3` | Review rounds before the decision is left to you |
| `flotilla.merge.checkCommand` | `""` | Checks run on a merge before the base branch moves (default: the `typecheck` and `test` scripts) |
| `flotilla.merge.onApprove` | `ask` | When a ticket is approved: offer to merge it (`ask`), merge it (`auto`), or nothing (`off`) |
| `flotilla.agents.model` / `.effort` | `""` | Model and effort for agents on tickets (a ticket can choose its own) |
| `flotilla.agents.lightModel` | `""` | Model for tickets marked Light (small, mechanical work). Reviewed by `flotilla.agents.model`, and moved up to it when the work turns out hard. Empty: no ticket is Light |
| `flotilla.agents.autoCompactWindow` | `200000` | Context size agents compact against, so each turn re-reads less. 0: Claude Code's own |
| `flotilla.agents.subagentModel` | `"sonnet"` | Model of agents' search subagents (never stronger than the agent's own). Empty: the agent's own |
| `flotilla.agents.guardOutput` | `true` | Refuse whole reads of big files and whole large diffs, with how to look instead |
| `flotilla.agents.tokenBudget` | `25` | Millions of tokens an agent may re-read before it's stopped and its ticket asks you; agents repeating a failing command are stopped too. 0: no budget |
| `flotilla.chats.bigContext` | `200000` | Context size at which a chat is marked big, and you're told once what it costs. 0: never |
| `flotilla.agents.lean` | `true` | Start agents without your skills, plugins and MCP servers, with the coding tools only: a quarter less context re-read every turn |
| `flotilla.ask.model` | `"sonnet"` | Model that answers in a ticket's Ask chat |
| `flotilla.review.model` / `.effort` | `""` | Model and effort for reviewer agents |
| `flotilla.autopilot.avoidClashes` | `true` | The autopilot holds back a ticket that would change files a ticket in progress changes, until that one is merged |
| `flotilla.agents.maxRunning` | `2` | How many agents run at once, in all (the autopilot's, reviews, resumes); the rest wait in a queue |
| `flotilla.agents.maxPrioritized` | `2` | How many agents Prioritize may run above `maxRunning` at once; at this ceiling it asks which running agent to pause |
| `flotilla.agents.permissionMode` | `auto` | What agents without a window may do (user settings only) |
| `flotilla.agents.claudePath` | `""` | The Claude Code CLI agents run with (user settings only) |

## Requirements

- git 2.17 or newer in each environment (host and container).
- For chat status: [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), and Node.js on the PATH where it runs (the hooks are small Node scripts).

## Privacy and security

- **No telemetry.** Flotilla makes network requests only to what you connect: Jira (with the API token you give it) and GitHub Issues (with VS Code's GitHub sign-in), to read issues, and to write to them only after you confirm each write. Besides that it runs git, including the push, pull and fetch you ask for.
- **Agents are Claude Code.** The agents Flotilla starts run the Claude Code CLI with your account and your Claude Code settings; what they send to Anthropic is as with any Claude Code chat.
- **Credentials** (the Jira token) are kept in VS Code's secret storage, never in files.
- **What it writes:**
  - Files you create, edit or move through it.
  - In each worktree's git directory: `flotilla/` (chat records, the ticket it works on) and a heartbeat file.
  - The backlog, in `.flotilla/backlog/` in the main worktree (kept out of git): tickets, their images, the integrations you connect (no credentials), and the autopilot's switch (signed with a key in secret storage, so agents can't turn it on).
  - When a ticket's worktree is set up: a `commit-msg` hook that checks commit messages start with the ticket's id (an existing hook is kept and still runs). Hooks kept in your repository's files (`core.hooksPath`) are left alone.
  - When you clean up a ticket's history: the old commits under `refs/flotilla/history/` (local refs, not pushed).
  - With your consent: `.claude/settings.local.json` and `.claude/flotilla-hook.js` in each worktree (both kept out of git through `.git/info/exclude`).
  - When you open a chat from another worktree: a copy of its transcript in Claude Code's chat folder. When linked chats get titles: a title line in their transcript (`flotilla.tagChatTitles`).
- **What it reads:** your repository and its worktrees, and Claude Code's transcripts in `~/.claude/projects/`.
- **The Claude Code hook** is a readable script, `.claude/flotilla-hook.js`. It records each chat's state in the worktree's git directory, and tells new chats about the backlog's guide.
- **Settings a repository can't change**: `flotilla.agents.permissionMode` and `flotilla.agents.claudePath` are read from your user settings only.
- **Trusted workspaces only:** Flotilla runs git, your `flotilla.setupCommand`, the hooks and agents, so it stays off in VS Code's Restricted Mode.

Please report security issues privately through [GitHub's security advisories](https://github.com/archipelagic-chef/flotilla/security/advisories/new) rather than in a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and trying Flotilla across host and devcontainer.
