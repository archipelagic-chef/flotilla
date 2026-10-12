/**
 * Messages between the extension host and the sidebar webview. Type-only: imported by both sides,
 * so it must not import vscode, node or DOM APIs.
 */
import type { ChangeKind } from '../core/git/porcelain';
import type { BacklogItem, BacklogPriority, BacklogStatus } from '../features/backlog/backlog';
import type { ChatState, LinkKind } from '../features/chats/chats';
import type { CiJob, CiRun } from '../features/ci/githubActions';
import type { RunAction } from '../features/ci/runActions';
import type { FileMatches, SearchOptions } from '../features/search/gitGrep';
import type { AttentionState } from '../features/workstreams/attention';

/** The tools in the strip on the left. */
export type Tool = 'overview' | 'backlog' | 'files' | 'search' | 'vc' | 'chats';

export type { BacklogItem, BacklogPriority, BacklogStatus };

/** A backlog item as the sidebar lists it: with the first line of its description and its activity count. */
export interface BacklogItemView extends BacklogItem {
  summary?: string;
  activity: number;
  /** An issue from an integration (Jira, GitHub Issues), not a local item. */
  source?: { kind: 'jira' | 'github'; label: string; url: string; statusName: string };
  /** The ticket has a run block (BL-19 finds it): its card gets a Run button and a Run menu item. */
  runnable?: boolean;
  /** A local item's linked issues, with their current status where they're listed. */
  linked?: Array<{ id: string; kind: 'jira' | 'github'; title: string; url: string; statusName?: string }>;
}

/** Integrations whose issues don't load, to show in the backlog. */
export interface BacklogProblem {
  label: string;
  error: string;
}

/** The views under Version Control in the tool strip. */
export type VcView = 'changes' | 'history' | 'compare' | 'ci';

/** A workflow run as the CI/CD view shows it; current: it runs the commit checked out in the worktree. */
/** A job of a run, with its steps. */
export type CiJobView = CiJob;

export interface CiRunView extends CiRun {
  current: boolean;
  /** The run's jobs, with their steps, once read: only for a run the user expanded. */
  jobs?: CiJob[];
  jobsError?: string;
}

/** A worktree's CI/CD: its branch's latest runs on GitHub, or why there are none. */
export type CiView =
  | { kind: 'signIn' }
  | { kind: 'unpublished' }
  | { kind: 'unsupported' }
  | { kind: 'error'; error: string }
  | { kind: 'runs'; repo: string; branch: string; runs: CiRunView[] };

/** How a worktree is compared with a base: since they diverged, that plus uncommitted changes, or base..HEAD. */
export type CompareMode = 'mergeBase' | 'uncommitted' | 'twoDot';

/** How two refs are compared: what the second changed since it split from the first, or every difference. */
export type RefCompareMode = 'mergeBase' | 'twoDot';

/** The worktree tab that shows every worktree. */
export const ALL = 'all';

export interface SearchGroup {
  key: string;
  files: FileMatches[];
}
export type ChangeGroup = 'staged' | 'unstaged';

export interface FileChangeView {
  path: string;
  origPath?: string;
  kind: ChangeKind;
}

export interface ChatView {
  id: string;
  title: string;
  state: ChatState;
  message?: string;
  open: boolean;
  /** What it waits for from the user: an approval (a command, an edit), or a reply to its output. */
  awaiting?: 'approval' | 'reply';
  linkedBy: LinkKind;
  /** Branch (or folder) the chat runs in, when it is linked here from elsewhere. */
  via?: string;
  /** "2m", "3h", "yesterday"-style age. */
  age: string;
}

export interface WorkstreamView {
  key: string;
  branch: string;
  /** Short tab label: the ticket id in the branch, or its last part. */
  label: string;
  initials: string;
  reachable: boolean;
  isMain: boolean;
  isCurrent: boolean;
  inWorkspace: boolean;
  attention: AttentionState;
  /** One line: status, progress, sync, window. */
  description: string;
  /** Plain-text summary (branch, path, status) for screen readers and tests. */
  tooltip: string;
  /** The worktree's folder (or where it was, when unreachable). */
  path: string;
  /** What the agent last said (a question when it waits for input). */
  agentMessage?: string;
  /** The first changes of each list (flotilla.changes.limit); totals has how many there are in all. */
  staged: FileChangeView[];
  unstaged: FileChangeView[];
  totals: { staged: number; unstaged: number };
  sync: { kind: 'publish' | 'sync' | 'none'; text: string; ahead: number; behind: number; head?: string };
  chats: ChatView[];
  hasHooks: boolean;
  /** `;`-separated tokens for context-menu when-clauses, as in `webviewWorkstream =~ /;linked;/`. */
  context: string;
}

/** How the webview finds a file's or folder's icon in the user's file icon theme. */
export interface IconMap {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}

export interface DirEntry {
  name: string;
  dir: boolean;
  /** Ignored by git (.gitignore, info/exclude, core.excludesFile); shown greyed out, like in the Explorer. */
  ignored?: boolean;
}

/** A commit in a worktree's history. */
export interface CommitView {
  hash: string;
  short: string;
  subject: string;
  /** The rest of the message, after the subject. */
  body: string;
  author: string;
  /** ISO 8601 author date. */
  date: string;
  /** Branches and tags pointing at it, as git log --decorate prints them. */
  refs: string[];
  parents: string[];
  /** Not on the upstream yet (or on no remote, for an unpublished branch). */
  outgoing: boolean;
}

export type HostMessage =
  /** The worktrees whose view changed since the last state, and every key in order (a worktree that's gone is left out). */
  | { type: 'state'; workstreams: WorkstreamView[]; keys: string[]; machine: MachineState }
  | { type: 'dir'; key: string; path: string; entries: DirEntry[] }
  /** Directories that changed on disk; the webview re-lists the ones it shows. */
  | { type: 'dirsChanged'; key: string; paths: string[] }
  /** Scroll to a workstream; with path, expand to and highlight that file in the Files tab. */
  | { type: 'reveal'; key: string; path?: string; tool?: Tool }
  /** Show a worktree's history with a ticket's commits highlighted, and the one clicked (on the ticket) selected. */
  | { type: 'showCommits'; key: string; ticket: string; hashes: string[]; selected: string }
  /** The active worktree changed outside the webview (shortcut, status bar). */
  | { type: 'active'; key: string }
  /** Worktrees whose tab is closed (still in the Overview). */
  | { type: 'tabs'; closed: string[] }
  /** Exclusions VS Code's settings still lack for a worktrees folder in the main folder (empty: none to show). */
  | { type: 'exclusions'; missing: string[] }
  | { type: 'searchResults'; id: number; groups: SearchGroup[]; truncated: boolean; limit: number; error?: string }
  /** The file icon theme (undefined: none, use generic icons). */
  | { type: 'iconTheme'; theme: { css: string; map: IconMap } | undefined }
  /** A replace finished; the webview searches again. */
  | { type: 'replaced'; count: number }
  | { type: 'tool'; tool: Tool }
  /** Show an inline name box: a new file or folder in dir, or a rename of path. */
  | { type: 'edit'; key: string; kind: 'file' | 'folder'; dir: string }
  | { type: 'edit'; key: string; kind: 'rename'; path: string }
  /** The result of a create/rename from the inline box; on error the box stays open with the message. */
  | { type: 'editResult'; ok: boolean; error?: string }
  /** A commit from the message box succeeded; the webview clears that box. */
  | { type: 'committed'; key: string }
  /** Branches and tags to compare; defaultBase is flotilla.defaultBase or the remote's default branch. */
  | { type: 'refs'; defaultBase?: string; local: string[]; remote: string[]; tags: string[] }
  /** The files that differ in comparison id. */
  | { type: 'compared'; id: number; files: FileChangeView[]; error?: string }
  /** The backlog, in priority order; sent at start and whenever it changes. */
  | { type: 'backlog'; items: BacklogItemView[]; problems: BacklogProblem[]; integrations: number; autopilot?: AutopilotState }
  /** The CI/CD view of every worktree (by key); sent whenever a worktree's runs are read. */
  | { type: 'ci'; views: Record<string, CiView> }
  /** What's in progress per tool (titles), for the tool strip's icons. */
  | { type: 'progress'; tools: Partial<Record<Tool, string[]>> }
  /** Fold (or unfold) every worktree section of the All tab. */
  | { type: 'fold'; folded: boolean }
  /** The files a commit changed (against its first parent). */
  | { type: 'commitFiles'; key: string; hash: string; files: FileChangeView[]; error?: string }
  /** A page of a worktree's history, starting at skip; head is the commit it was read from. */
  | { type: 'log'; key: string; head: string | undefined; skip: number; commits: CommitView[]; more: boolean; error?: string };

/** What a command acts on. Context-menu commands receive this too (merged with VS Code's webview fields). */
/** The machine, for the Overview: its free memory, the agents working in every window, and the windows open on worktrees. */
export interface MachineState {
  /** Free memory, in MB. */
  freeMB: number;
  /** Below this (flotilla.agents.minFreeMemoryMB), no agent starts. */
  minFreeMB: number;
  /** Claude Code chats working now (in any window). */
  agents: number;
  /** Worktrees with a window open on them. */
  windows: number;
}

/** The autopilot: whether it's on, its agents, and whether it waits for Claude's usage limit or for memory. */
export interface AutopilotState {
  enabled: boolean;
  running: number;
  max: number;
  /** ISO 8601. */
  waitingUntil?: string;
  /** Too little memory free to start an agent. */
  waitingForMemory?: boolean;
  /** Another window runs it. */
  elsewhere: boolean;
}

export interface Target {
  key: string;
  path?: string;
  group?: ChangeGroup;
  chatId?: string;
  /** With chatId: a message to fill in the chat's message box. */
  prompt?: string;
  /** Files of a multi-selection, in the same group. */
  paths?: string[];
  /** In the Files tab: path is a folder. */
  isDir?: boolean;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'listDir'; key: string; path: string }
  | { type: 'openFile'; key: string; path: string; preview: boolean; line?: number; range?: [number, number] }
  /** The user picked a worktree tab (key or ALL). */
  | { type: 'active'; key: string }
  /** limit: matches per worktree (more after "Show more"); the setting flotilla.search.maxResults by default. */
  | { type: 'search'; id: number; scope: string; query: string; options: SearchOptions; limit?: number }
  /** Replace every match in the scope, or only in one file (key + path). */
  | { type: 'replace'; scope: string; query: string; options: SearchOptions; replacement: string; key?: string; path?: string }
  /** VS Code views Flotilla doesn't replace, from the bottom of the tool strip. */
  | { type: 'openView'; view: 'extensions' | 'debug' }
  | { type: 'commit'; key: string; message: string; amend?: boolean; then?: 'push' | 'sync' }
  | { type: 'create'; key: string; kind: 'file' | 'folder'; dir: string; name: string }
  | { type: 'rename'; key: string; path: string; name: string }
  /** Drag and drop: move a file or folder into dir (same or another worktree). */
  | { type: 'move'; from: { key: string; paths: string[] }; to: { key: string; dir: string } }
  /** Runs a `flotilla.*` command with the target as its argument. */
  | { type: 'command'; command: string; target?: Target }
  /** Read a page of a worktree's history (newest first). */
  | { type: 'log'; key: string; skip: number }
  /** Open the files a commit changed in a multi-file diff; with path, only that file's diff. */
  | { type: 'openCommit'; key: string; hash: string; path?: string }
  | { type: 'commitFiles'; key: string; hash: string }
  | { type: 'copy'; text: string }
  | { type: 'refs' }
  /** The CI/CD view: sign in to GitHub (asks), or read the runs again now. */
  | { type: 'ci'; op: 'signIn' | 'refresh' }
  /** A run expanded or collapsed in a worktree's CI/CD view: its jobs are read while it's expanded. */
  | { type: 'ci'; op: 'expand' | 'collapse'; key: string; runId: number }
  /** Shows a job's log (read-only, cleaned, at its first error). */
  | { type: 'ci'; op: 'showLog'; key: string; jobId: number; jobName: string }
  /** A run's action in the CI/CD view, for a worktree (key): a cancel asks first. */
  | { type: 'ci'; op: 'act'; key: string; run: number; action: RunAction }
  /** Opens a link on GitHub (a workflow run). */
  | { type: 'openUrl'; url: string }
  /** Whether there are worktree sections to fold, and whether they all are: for Fold All in the view title. */
  | { type: 'folding'; canFold: boolean; allFolded: boolean }
  /** Add an item (VS Code's input box asks for its title). */
  | { type: 'backlog'; op: 'new' }
  /** priority null clears it. */
  | { type: 'backlog'; op: 'update'; id: string; title?: string; notes?: string; status?: BacklogStatus; priority?: BacklogPriority | null }
  /** Drag and drop: into a lane, before another item or at the lane's end. */
  | { type: 'backlog'; op: 'move'; id: string; status: BacklogStatus; before?: string }
  /** start: create its worktree and start an agent there; open: its ticket; ai: write it with Claude; run: its run block (BL-20). */
  | { type: 'backlog'; op: 'delete' | 'start' | 'open' | 'ai' | 'link' | 'accept' | 'dismiss' | 'run'; id: string }
  /** Accept every proposed item; plan the backlog with Claude. */
  | { type: 'backlog'; op: 'acceptAll' | 'plan' }
  /** Turn the autopilot on or off. */
  | { type: 'backlog'; op: 'autopilot' }
  /** The Integrations menu, or reread the integrations' issues. */
  | { type: 'backlog'; op: 'integrations' | 'refresh' }
  | { type: 'compare'; id: number } & RefComparison
  /** Open the diff of one file of a comparison, or (without path) of all of them. */
  | ({ type: 'openCompare'; path?: string } & RefComparison);

/** Two refs to compare (what differs between them); with worktree (a key), head's side is that worktree's files, uncommitted changes included. */
export interface RefComparison {
  base: string;
  head: string;
  worktree?: string;
}
