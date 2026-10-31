/**
 * Messages between the extension host and the sidebar webview. Type-only: imported by both sides,
 * so it must not import vscode, node or DOM APIs.
 */
import type { AgentActivity } from '../features/chats/activity';
import type { ChangeKind } from '../core/git/porcelain';
import type { MetricsHostMessage, MetricsWebviewMessage } from './metricsProtocol';
import type { MergeInfo } from '../features/backlog/merged';
import type {
  AgentChoice,
  AgentEffort,
  BacklogItem,
  BacklogPriority,
  BacklogStatus,
} from '../features/backlog/backlog';
import type { Need } from '../features/backlog/needs';
import type { RunKind } from '../features/backlog/runBlocks';
import type { ReviewFix } from '../features/backlog/review';
import type { NoteOutcome } from '../features/backlog/notes';
import type { Question } from '../features/backlog/report';
import type { ChatState, LinkKind } from '../features/chats/chats';
import type { CiJob, CiRun } from '../features/ci/githubActions';
import type { RunAction } from '../features/ci/runActions';
import type { CiDeployment } from '../features/ci/githubDeployments';
import type { FileMatches, SearchOptions } from '../features/search/gitGrep';
import type { AttentionState } from '../features/workstreams/attention';
import type { TicketCommit } from '../features/history/log';
import type { TicketChange } from './ticketProtocol';

/** The tools in the strip on the left. */
export type Tool = 'overview' | 'backlog' | 'metrics' | 'files' | 'search' | 'vc' | 'chats';

export type { BacklogItem, BacklogPriority, BacklogStatus };
export type { MergeInfo };

/** A backlog item as the sidebar lists it: with the first line of its description and its activity count. */
export interface BacklogItemView extends BacklogItem {
  summary?: string;
  activity: number;
  /** An issue from an integration (Jira, GitHub Issues), not a local item. */
  source?: { kind: 'jira' | 'github'; label: string; url: string; statusName: string };
  /** The ticket's run: its last run block (BL-19 finds it). Its row gets a Run button and a Run menu item. */
  run?: { kind: RunKind; title?: string; lines: string[] };
  /** A local item's linked issues, with their current status where they're listed. */
  linked?: Array<{ id: string; kind: 'jira' | 'github'; title: string; url: string; statusName?: string }>;
  /** Whether its work is merged into the base (read from git; undefined: no branch to tell about). */
  merge?: MergeInfo;
  /** A worktree is being created for it in this window: its row shows it, and its Start button waits. */
  creating?: boolean;
  /** Why it waits on the user (its row in "Needs you"). */
  need?: Need;
  /** Its start waiting in the agents' queue (BL-212): what for, why, and its place in line. */
  queued?: { kind: 'reply' | 'review' | 'resume' | 'new'; reason: 'slot' | 'memory'; place: number; since?: string };
  /** The tickets it depends on that aren't done ("Depends on: BL-12" in its description): it waits for them. */
  waitsFor?: string[];
  /** The open tickets that wait for it (BL-238), directly or through a chain: its "Needs you" row says it holds them up. */
  holdsUp?: string[];
  /** Where each of those stands (BL-205): what it waits for you to do, or else how far it is ("in progress", "merge failed"). */
  waitsOn?: Array<{ id: string; standing: string }>;
  /** The tickets it depends on that were discarded (BL-235): it no longer waits for them. */
  depsDiscarded?: string[];
  /** An epic's parts (BL-205): how many it has, and how many are done. The autopilot takes its parts, not the epic. */
  parts?: { done: number; total: number };
  /** Its agent stopped without a question, to be resumed (BL-198): the tickets it said it waits for, not merged yet and merged. */
  resume?: { waits: string[]; merged: string[] };
  /** The autopilot holds it back: it would change files this ticket in progress changes (BL-71). */
  clash?: { with: string; files: string[] };
  /** Its merge's checks are running (BL-169): the step, and how far the tests are. */
  checks?: { step?: string; percent?: number };
  /** Main's name, as its branches' conflicts with it are told ("main"). */
  base?: string;
  /** Its ticket shows a recorded demo (BL-135): its review card has a demo mark. */
  demo?: boolean;
  /** Its discussion's chat is open (BL-188): its card says Discussing, and opens that chat. */
  discussing?: boolean;
  /** The ticket whose sister check covers it (BL-236): the autopilot waits for it, and its card says so. */
  checking?: string;
  /** You stopped that check (BL-240): its card says it's stopping until the leading window ends it. */
  checkStopped?: boolean;
}

/** A note (BL-182), as the backlog's Notes lane shows it. */
export interface NoteView {
  id: string;
  title: string;
  /** The note as written. */
  text: string;
  created: string;
  /** Working: an agent handles it now. */
  status: 'open' | 'working' | 'asking' | 'handled';
  agent?: string;
  /** Handled with another note, which leads (its questions and answers are there). */
  with?: string;
  /** What its agent asks: its words, its questions to click, and since when (ISO 8601). */
  asks?: { reply: string; questions: Question[]; since?: string };
  /** Open, its agent waits for Claude's limit to lift (BL-203): until when (ISO 8601), whether the reset was said. */
  waits?: { until: string; known: boolean; kind: 'usage' | 'rate' | 'overloaded' };
  became: NoteOutcome[];
  handled?: string;
}

/** Integrations whose issues don't load, to show in the backlog. */
export interface BacklogProblem {
  label: string;
  error: string;
}

/** The views under Version Control in the tool strip. */
export type VcView = 'changes' | 'history' | 'compare' | 'ci' | 'ticketChanges' | 'ticketCommits';

/**
 * A ticket as Version Control shows it when a worktree is the ticket's (BL-171): its header, its Changes (every file it
 * changes, as the ticket's Changes section lists them) and its Commits (stepped through one by one).
 */
export interface TicketVcView {
  id: string;
  title: string;
  change: TicketChange;
  /** Newest first, as the ticket lists them. */
  commits: TicketCommit[];
}

/** A workflow run as the CI/CD view shows it; current: it runs the commit checked out in the worktree. */
/** A job of a run, with its steps. */
export type CiJobView = CiJob;

export interface CiRunView extends CiRun {
  current: boolean;
  /** The run's jobs, with their steps, once read: only for a run the user expanded. */
  jobs?: CiJob[];
  jobsError?: string;
  /** Its action on its way (BL-119): from the click until GitHub answered and the runs were read again, or the agent's chat opened. */
  busy?: RunBusy;
}

/** What a run can be busy with: one of its actions, or Fix with Agent. */
export type RunBusy = RunAction | 'fix';

/** What a worktree's CI view can be busy with: a Refresh (of every view), or a Run Workflow… on its branch. */
/** runCi: a ticket's Run CI (BL-222), pushing its branch or re-running its latest run. */
export type CiBusy = 'refresh' | 'runWorkflow' | 'runCi';

/**
 * A worktree's CI/CD: its branch's latest runs and deployments on GitHub, or why there are none. Deployments are read
 * apart from the runs: when they can't be read, the runs still show and deploymentsError says why.
 */
export type CiView = (
  | { kind: 'signIn' }
  /** repo: origin is this GitHub repository and the worktree has workflows, so a push would run them (BL-222). */
  | { kind: 'unpublished'; repo?: string }
  | { kind: 'unsupported' }
  | { kind: 'error'; error: string }
  | { kind: 'runs'; repo: string; branch: string; runs: CiRunView[]; deployments: CiDeployment[]; deploymentsError?: string }
) & { busy?: CiBusy[] };

/** What a CI view (the sidebar's CI/CD view, or a ticket's CI) asks of the extension about a worktree's runs (key). */
export type CiRequest =
  /** Sign in to GitHub (asks), or read the runs again now. */
  | { op: 'signIn' | 'refresh' }
  /** A run expanded or collapsed: its jobs are read while it's expanded. */
  | { op: 'expand' | 'collapse'; key: string; runId: number }
  /** Shows a job's log (read-only, cleaned, at its first error). */
  | { op: 'showLog'; key: string; jobId: number; jobName: string }
  /** A run's action: a cancel asks first. */
  | { op: 'act'; key: string; run: number; action: RunAction }
  /** Fix with Agent on a failed job of a run (BL-7). */
  | { op: 'fix'; key: string; run: number; job: number }
  /** A ticket's Run CI (BL-222): pushes the branch when origin lacks its head, else re-runs its latest run. */
  | { op: 'runCi'; key: string }
  /** A ticket's Run Workflow… (BL-222): the CI/CD view's run-by-hand, on the worktree's branch. */
  | { op: 'runWorkflow'; key: string };

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
  /** A folder of untracked files listed as one entry: how many files it holds. */
  files?: number;
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
  /** Its record says working, but it went quiet: it shows as stopped (BL-131). */
  stalled?: boolean;
  /** Its context ("210k"), what that costs (the tooltip), and whether it's past flotilla.chats.bigContext (BL-70). */
  size?: { label: string; tip: string; big: boolean };
  /** The agent and backlog item its first line names (agentChatItem): its ticket's card shows the agent (BL-96). */
  agent?: { name: string; item: string };
  /** What it's doing (BL-175), while it works; and why it looks stuck, when it does (flotilla.agents.stuck.*). */
  activity?: AgentActivity;
  stuck?: string;
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
  /** It's being removed (BL-119): from the confirmation until it's gone, or the removal failed. */
  removing?: boolean;
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
  | MetricsHostMessage
  /** The worktrees whose view changed since the last state, and every key in order (a worktree that's gone is left out). */
  | { type: 'state'; workstreams: WorkstreamView[]; keys: string[]; machine: MachineState }
  | { type: 'dir'; key: string; path: string; entries: DirEntry[] }
  /**
   * The change marks (by path) of the entries in the folders the Files tab has listed, from all of the worktree's
   * changes, not only those in its view; sent after a listing and when they change.
   */
  | { type: 'marks'; key: string; marks: Record<string, ChangeKind> }
  /** Directories that changed on disk; the webview re-lists the ones it shows. */
  | { type: 'dirsChanged'; key: string; paths: string[] }
  /** Scroll to a workstream; with path, expand to and highlight that file in the Files tab. */
  | { type: 'reveal'; key: string; path?: string; tool?: Tool; vcView?: VcView }
  /** Show a worktree's history with a ticket's commits highlighted, and the one clicked (on the ticket) selected. */
  | { type: 'showCommits'; key: string; ticket: string; hashes: string[]; selected: string }
  /** Expand in a ticket's Changes (BL-171): Version Control on the ticket's Changes in its worktree, that file selected. */
  | { type: 'showTicketChanges'; key: string; ticket: string; path: string }
  /** A ticket's changes and commits (asked for with ticketVc); undefined: it isn't a ticket (anymore). */
  | { type: 'ticketVc'; id: string; view?: TicketVcView }
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
  | {
      type: 'backlog';
      items: BacklogItemView[];
      problems: BacklogProblem[];
      integrations: number;
      autopilot?: AutopilotState;
      mergeQueue?: MergeQueueView;
      /** The cards show every detail (flotilla.backlog.cards, BL-183). */ detailedCards?: boolean;
      /** The agents' default model and effort, for the title bar (BL-242). */ agentDefaults?: AgentChoice;
    }
  /** The notes (BL-182), oldest first; sent at start and whenever they change. */
  | { type: 'notes'; notes: NoteView[] }
  /** A note's action is finished (as a backlog action's is): a card's × shows working until then (BL-215). */
  | { type: 'noteDone'; message: Extract<WebviewMessage, { type: 'note' }>; failed?: boolean }
  /** A backlog action (the webview's message, as it was sent) is finished, the board posted: failed if it threw (BL-117). */
  | { type: 'backlogDone'; message: Extract<WebviewMessage, { type: 'backlog' }>; failed?: boolean }
  /** The CI/CD view of every worktree (by key); sent whenever a worktree's runs are read. */
  | { type: 'ci'; views: Record<string, CiView> }
  /** What's in progress per tool (titles), for the tool strip's icons. */
  | { type: 'progress'; tools: Partial<Record<Tool, string[]>> }
  /** The repository is on a slow drive (undefined: it isn't). */
  | { type: 'storage'; slow?: SlowStorageView }
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
/** The merge queue (BL-140), first to land first: each ticket's state in the merge train, and what the queue does now. */
export interface MergeQueueView {
  /**
   * run: Land All, Resolving Conflicts (BL-226), or its own Land, Resolving Conflicts, has an agent at its conflict, or
   * it needs you. auto: it lands on its own (BL-247: Land, Resolving Conflicts).
   */
  entries: Array<{ id: string; state: 'clean' | 'conflicts' | 'unknown'; run?: 'resolving' | 'needs you'; auto?: boolean }>;
  /** "BL-122's merge", "rebuilding the merge train". */
  working?: string;
}

export interface AutopilotState {
  enabled: boolean;
  running: number;
  /** Merges' agents and checks running in this window (BL-164): Pause All pauses them too. */
  merging?: number;
  max: number;
  /** Starts waiting for a free slot (in the queue: reviews and resumes go first). */
  waiting: number;
  /** ISO 8601. */
  waitingUntil?: string;
  /** When Try Now last found the limit still there (BL-132). */
  triedAt?: string;
  /** Too little memory free to start an agent. */
  waitingForMemory?: boolean;
  /** A note is due (BL-220): its agent gets the next free slot first. */
  noteFirst?: string;
  /** Another window runs it. */
  elsewhere: boolean;
  /** Why it starts nothing though a slot is free (BL-142). */
  idle?: string;
  /** What it did while the user was away ("Overnight: 6 tickets done, 3 waiting for you"). */
  away?: string;
  /** Pause All holds every agent (BL-160): how many it paused. */
  pausedAll?: number;
  /** The agents working now, for its details (BL-153). */
  agents?: AutopilotAgent[];
  /** The starts waiting, in the order they start in. */
  queue?: AutopilotQueued[];
}

/** An agent working for a ticket: what it does (its work, a review, or it's starting), and since when (ISO 8601). */
export interface AutopilotAgent {
  id: string;
  agent?: string;
  doing: 'work' | 'review' | 'starting';
  since?: string;
  /** The user paused or stopped it, but its process still runs here: it's counted, and its line says so (BL-201). */
  held?: 'paused' | 'stopped';
  /** Why it isn't counted, though its chat says it's working: "paused by you, though its chat says it's working". */
  uncounted?: string;
}

/** A start waiting: for a free slot or for memory; a reply, a review, a resume or a new ticket. */
export interface AutopilotQueued {
  id: string;
  reason: 'slot' | 'memory';
  kind: 'reply' | 'review' | 'resume' | 'new';
  since?: string;
}

/** A repository on a slow drive: what the Overview says, and how to fix it. */
export interface SlowStorageView {
  message: string;
  fix: string;
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
  | MetricsWebviewMessage
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
  /** A ticket's changes and commits, for Version Control's ticket views (answered with ticketVc). */
  | { type: 'ticketVc'; id: string }
  /** A file of a ticket's Changes in the diff editor (group: its index in the ticket's change). */
  | { type: 'openTicketChange'; id: string; group: number; path: string }
  /** Back to the ticket, its Changes at that file. */
  | { type: 'backToTicket'; id: string; path?: string }
  | { type: 'copy'; text: string }
  | { type: 'refs' }
  | ({ type: 'ci' } & CiRequest)
  /** Opens a link on GitHub (a workflow run). */
  | { type: 'openUrl'; url: string }
  | { type: 'openSite'; url: string }
  /** The CI/CD view: starts a workflow by hand on the worktree's branch (asks first). */
  | { type: 'runWorkflow'; key: string }
  /** Whether there are worktree sections to fold, and whether they all are: for Fold All in the view title. */
  | { type: 'folding'; canFold: boolean; allFolded: boolean }
  /** Opens a new note in the editor, or a sent note's tab (BL-182); to answer it, focused on its first question (BL-216); or deletes it (asks first, BL-215). */
  | { type: 'note'; op: 'new' }
  | { type: 'note'; op: 'open'; id: string; answer?: boolean }
  | { type: 'note'; op: 'delete'; id: string }
  /** Add an item (VS Code's input box asks for its title). */
  | { type: 'backlog'; op: 'new' }
  /** priority null clears it. */
  | { type: 'backlog'; op: 'update'; id: string; title?: string; notes?: string; status?: BacklogStatus; priority?: BacklogPriority | null }
  /** Drag and drop: into a lane, before another item or at the lane's end. */
  | { type: 'backlog'; op: 'move'; id: string; status: BacklogStatus; before?: string }
  /** start: create its worktree and start an agent there; open: its ticket; discuss: talk it through with an agent (BL-45); run: its run block (BL-20); merge: merge its approved work (a card's next step, BL-183). */
  | { type: 'backlog'; op: 'delete' | 'start' | 'open' | 'discuss' | 'link' | 'accept' | 'dismiss' | 'run' | 'merge'; id: string }
  /** Discard as "won't do" (asks first), and Reopen a discarded item into To Do (BL-209). */
  | { type: 'backlog'; op: 'discard' | 'reopen'; id: string }
  /** Keeps a ticket a sister check found covered or at odds (BL-236): as it is, out of "Needs you". */
  | { type: 'backlog'; op: 'keepSister'; id: string }
  /** Stops the sister check that holds this To Do card (BL-240): its sisters are released, unchecked. */
  | { type: 'backlog'; op: 'stopCheck'; id: string }
  /** The card's Create Worktree (as the ticket's): a new worktree at once, its branch named without asking unless named. */
  | { type: 'backlog'; op: 'createWorktree'; id: string; named?: boolean }
  /** Accept every proposed item; plan the backlog with Claude. */
  | { type: 'backlog'; op: 'acceptAll' | 'plan' }
  /** Turn the autopilot on or off. */
  | { type: 'backlog'; op: 'autopilot' }
  /** The agents' default model or effort, from the title bar's dropdowns (BL-242): null is Claude Code's; a model of 'other' asks for its name. */
  | { type: 'backlog'; op: 'defaultModel'; model: string | null }
  | { type: 'backlog'; op: 'defaultEffort'; effort: AgentEffort | null }
  /** Sets the agent limit (flotilla.agents.maxRunning), from the autopilot's details. */
  | { type: 'backlog'; op: 'maxAgents'; max: number }
  | { type: 'backlog'; op: 'tryNow' }
  /** Pause All Agents, Resume All Agents (BL-160). */
  | { type: 'backlog'; op: 'pauseAll' | 'resumeAll' }
  /** Check All: every ticket's Check (BL-163). */
  | { type: 'backlog'; op: 'checkAll' }
  /** Merge All Ready: lands the merge queue (BL-140). */
  /** resolve: Land All, Resolving Conflicts (BL-226). */
  | { type: 'backlog'; op: 'landAll'; resolve?: boolean }
  /** The queue bar's ×: takes a ticket out of the merge queue (BL-226). */
  | { type: 'backlog'; op: 'dequeue'; id: string }
  /** The merge queue dragged into a new order; Merge Next moves a ticket to its front (BL-144). */
  | { type: 'backlog'; op: 'queueOrder'; ids: string[] }
  | { type: 'backlog'; op: 'mergeNext'; id: string }
  /** Update from Main and Merge (BL-154): a conflicting card's next step. */
  | { type: 'backlog'; op: 'updateAndMerge'; id: string }
  /** Resume (BL-198): its agent, stopped to be resumed, goes on in its chat. */
  | { type: 'backlog'; op: 'resume'; id: string }
  /** Compact or Detailed cards (BL-183): saved in flotilla.backlog.cards. */
  | { type: 'backlog'; op: 'cards'; detailed: boolean }
  /** Needs you: answer or request changes (the ticket, its comment box focused); approve the work; the stop's fix. */
  /** comment: its ticket with the comment box focused; demo: its ticket at its Demo section (BL-135). */
  | { type: 'backlog'; op: 'comment' | 'approve' | 'demo'; id: string }
  | { type: 'backlog'; op: 'fix'; id: string; fix: ReviewFix }
  /** Needs you (queued reply): start it now, above the limit, or pause a running agent for it. */
  | { type: 'backlog'; op: 'prioritize'; id: string }
  /** The Integrations menu, or reread the integrations' issues. */
  | { type: 'backlog'; op: 'integrations' | 'refresh' }
  | ({ type: 'compare'; id: number } & RefComparison)
  /** Open the diff of one file of a comparison, or (without path) of all of them. */
  | ({ type: 'openCompare'; path?: string } & RefComparison);

/** What opens a Version Control file row's diff (its click's message); its right-click menu's Open Changes sends it again. */
export type VcFileDiff = Extract<WebviewMessage, { type: 'openCommit' | 'openTicketChange' | 'openCompare' }>;

/** Two refs to compare (what differs between them); with worktree (a key), head's side is that worktree's files, uncommitted changes included. */
export interface RefComparison {
  base: string;
  head: string;
  worktree?: string;
}
