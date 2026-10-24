/**
 * Messages between the extension host and a ticket editor tab. Type-only: imported by both sides, so it must not
 * import vscode, node or DOM APIs.
 */
import type { AgentChoice, AgentEffort, BacklogItem, BacklogPriority, BacklogStatus } from '../features/backlog/backlog';
import type { RemoteEditOptions } from '../features/backlog/sources/source';
import type { HistoryRewrite, HistoryVersion } from '../features/backlog/history';
import type { MergeInfo } from '../features/backlog/merged';
import type { ReviewFix, ReviewState } from '../features/backlog/review';
import type { Question } from '../features/backlog/report';
import type { MediaKind } from '../features/backlog/media';
import type { AttachmentKind } from '../features/backlog/attachments';
import type { TicketEntry } from '../features/backlog/ticket';
import type { AskView } from '../features/backlog/ask';
import type { AgentActivity, StuckRules } from '../features/chats/activity';
import type { AgentSummary } from '../features/chats/summary';
import type { RunBlockRef } from '../features/backlog/runBlocks';
import type { AttentionState } from '../features/workstreams/attention';
import type { TicketCommit } from '../features/history/log';
import type { CiRequest, CiView } from './protocol';
import type { CiStatus } from '../features/ci/githubActions';
import type { CiStop } from '../features/backlog/ciStop';
import type { ChecksProgress } from '../features/backlog/checksProgress';
import type { ChecksRunRecord } from '../features/backlog/merge';

/** A merge's checks running in the background (BL-169). */
export interface MergeChecksView {
  command: string;
  /** When this run started (ms since the epoch): the ticket counts the time. */
  started: number;
  /** Its log, the whole output so far. */
  log: string;
  progress: Omit<ChecksProgress, 'tail'>;
  /** The last lines. */
  tail: string[];
  /** This merge's earlier runs (BL-124's first, timeouts-only run). */
  earlier: ChecksRunRecord[];
}

/**
 * A ticket's CI (BL-106): its worktrees' branches with their CI/CD views (undefined: not read yet), and whether the
 * user keeps it open in this ticket.
 */
export interface TicketCiView {
  open: boolean;
  worktrees: Array<{ key: string; branch: string; view?: CiView }>;
}

/** An agent's chat, as a ticket entry links it: click to open it in Claude Code. */
export type AgentChatView =
  | {
      key: string;
      id: string;
      /** The agent's short name, which its reports are signed with ("a3f9"). */
      agent: string;
      title: string;
      state: 'working' | 'waiting-for-input' | 'done' | 'ended';
      /** Its record said working, but it went quiet with no process running (ISO 8601: its last activity). BL-131. */
      stalled?: string;
      /** What it asks, while it waits for you. */
      message?: string;
      branch: string;
      /** ISO 8601. */
      started: string;
      updated: string;
      /** The model and effort it ran with (its last reply's; before that, what it was started with). */
      model?: string;
      effort?: string;
      /** Its token use (BL-76): its context now ("84k"), and the totals for the tooltip. */
      tokens?: { label: string; tip: string; reRead: number };
      /** What it's doing, from its transcript (BL-175); `updated` is when it last wrote it. */
      activity?: AgentActivity;
      /** Its status in two lines, from a small model (BL-180): the latest asked, or the one being written. */
      summary?: AgentSummary;
    }
  /** Started, but Claude Code hasn't created the chat yet (its first message isn't sent). */
  | { pending: true; agent: string; headless?: boolean };

/** A start that waits: why, its place in the queue, and the agents running now out of the limit. */
export interface QueuedView {
  reason: 'slot' | 'memory';
  place: number;
  running: number;
  limit: number;
  /** What the start is for: a user's reply goes first in the queue. */
  kind: 'reply' | 'review' | 'resume' | 'new';
  /** When it began to wait, ISO 8601. */
  since?: string;
}

/** An agent's report, as the ticket shows it: the summary, what it needs from you (answered by clicking), the details. */
export interface ReportView {
  /** Rendered Markdown. */
  summary: string;
  /** Rendered Markdown, folded under the summary. */
  details: string;
  /** Its pictures, videos and diagrams (BL-114), rendered: under the summary, out of the details. */
  media?: string;
  /** The report asks the user something (its questions, or the Needs line's text). */
  asks: boolean;
  /** What the Needs line says it needs from the user: rendered Markdown. */
  needs?: string;
  questions: Question[];
  /** The comment of yours that answered it (the first after the report); undefined while it's unanswered. */
  answer?: string;
}

/** A report's picture, video or diagram (BL-114), as a thumbnail: its resolved source, or a diagram's Mermaid code. */
export interface MediaThumb {
  kind: MediaKind | 'diagram';
  src?: string;
  code?: string;
  alt?: string;
}

/** An attachment as the Attachments section shows it (BL-110). */
export interface AttachmentView {
  /** What the webview loads: the resolved source. */
  src: string;
  kind: AttachmentKind;
  name: string;
  /** Its caption: the reference's alt text (a diagram's: the line before it). */
  alt?: string;
  /** A diagram's Mermaid code (BL-136), and its place among its entry's diagrams. */
  code?: string;
  diagram?: number;
  /** Who added it (the entry's author), and when ("YYYY-MM-DD HH:MM"). */
  author?: string;
  date?: string;
  /** The activity entry that added it: "Show in activity" goes there. */
  entryKey?: string;
  from: 'description' | 'activity' | 'folder';
  demo: boolean;
  /** A demo's recording: the demo it was recorded from, as the recorder noted it in the file, and how long a GIF plays (BL-111). */
  recorded?: string;
  seconds?: number;
}

export interface TicketView {
  item: BacklogItem;
  /** Markdown, for editing. */
  description: string;
  descriptionHtml: string;
  /**
   * key: a local entry (a comment or an agent's report), which can be posted to an issue; posted: to which. anchor: its
   * id in the ticket file, to reply to it; reply: whom a reply answers (its body is without the reply line), and root:
   * the index of the top-level entry it shows under (BL-126).
   */
  activity: Array<
    TicketEntry & {
      html: string;
      key?: string;
      posted?: string;
      chat?: AgentChatView;
      report?: ReportView;
      /** Its pictures, videos and diagrams as thumbnails, beside its folded line (BL-114; those over their limits aside: the open entry says why). */
      thumbs?: MediaThumb[];
      anchor?: string;
      reply?: { to: string; author: string; date: string; label: string };
      root?: number;
    }
  >;
  /** For an issue from an integration: where it lives, and what can be changed from here (as its tracker allows). */
  remote?: {
    kind: 'jira' | 'github';
    label: string;
    url: string;
    statusName: string;
    priorityName?: string;
    edit?: RemoteEditOptions;
  };
  /**
   * The agents that worked on it (their chats), oldest first, with how many reports each wrote; where one that's busy
   * runs (without a window or in a terminal: it can be paused and stopped here; in Claude Code's panel: only there);
   * and whether the user paused or stopped it (it can be resumed).
   */
  agents: Array<Exclude<AgentChatView, { pending: true }> & { reports: number; runs?: 'headless' | 'terminal' | 'panel'; held?: 'paused' | 'stopped' }>;
  /** The issues local entries can be posted to: the issue itself, or a local item's linked issues. */
  postTargets: string[];
  /** A local item can get an issue created for it (a tracker is connected). */
  canCreateIssue: boolean;
  /** The issues in trackers a local item is linked to, with their current status if they're listed. */
  links: Array<{ id: string; kind: 'jira' | 'github'; title: string; url: string; statusName?: string }>;
  /** Its description and comments are still being read from its tracker. */
  loading?: boolean;
  /** Reading it from its tracker failed. */
  error?: string;
  /** The worktrees working on the item (several for an epic), with their agents' state and their git state. */
  worktrees: Array<{
    key: string;
    branch: string;
    attention: AttentionState;
    status: string;
    message?: string;
    /** Uncommitted changes. */
    changes: number;
    /** Against its upstream (none: not pushed). */
    ahead: number;
    behind: number;
    upstream?: string;
  }>;
  /** The ticket's run: the last run block its agents and Flotilla wrote (the Run button in review runs it). */
  run?: RunBlockRef;
  /** Its review loop, and whether an agent of it is running now. */
  review?: ReviewState & { running: boolean };
  /** Its agent waits for a free slot (or for memory) before it starts. */
  queued?: QueuedView;
  /** A worktree is being created for it in this window: its Start and Create buttons wait. */
  creating?: boolean;
  /** Review can be started (a local item with a worktree). */
  canReview: boolean;
  /** The item it's a part of, and its own parts (sub-tickets). */
  parent?: { id: string; title: string; status: BacklogStatus };
  children: Array<{ id: string; title: string; status: BacklogStatus; priority?: BacklogPriority; proposed: boolean }>;
  /** Its branches that have no worktree (anymore). */
  branches: string[];
  /** Its commits: on its branches (not yet on the base), or mentioning it or a linked issue. Newest first. */
  commits: TicketCommit[];
  /** A clean-up of its history in progress: how far the clean history is (it can be finished once no files differ). */
  rewrite?: HistoryRewrite & { differs: string[]; commits: number; cleanCommits: number; changes: number };
  /** Its histories kept from clean-ups, with their commits (newest first). */
  history: Array<HistoryVersion & { log: TicketCommit[] }>;
  /** It has a branch whose history can be cleaned up. */
  canCleanUp: boolean;
  /** Whether its work is merged into the base (read from git; undefined: no branch to tell about). */
  merge?: MergeInfo;
  /** It can be merged into the base branch (a local item, approved in review, not being merged). */
  canMerge: boolean;
  /** The branch it merges into. */
  mergeInto?: string;
  /**
   * Its Merge to main is on its way (BL-101): running, or waiting behind what waitsFor says ("BL-3's merge"); or
   * waiting for CI to pass (BL-105), its runs as last read (none yet: GitHub hasn't started them).
   */
  mergeProgress?: { waitsFor?: string; ci?: Array<{ workflow: string; number: number; status: CiStatus; url: string }> };
  /** Its merge's checks, running in the background now (BL-169): sent on its own as they go, about once a second. */
  mergeChecks?: MergeChecksView;
  /**
   * Why its last Merge to main stopped on CI (BL-112): red CI, with the failed jobs, or the base moved on. Only while
   * its branch is at the tip it stopped on; the ticket also drops a red stop once its CI shows other runs on that tip.
   */
  mergeStop?: CiStop;
  /** Its place in the merge queue (BL-140): "2nd of 3", what the train says of it, and the tickets that land before it. */
  mergeQueue?: { place: string; state?: string; ahead: string[] };
  /** A merge of it (Merge to main) waiting for a decision, and whether its agent is at it now. */
  merging?: NonNullable<BacklogItem['merging']> & { running: boolean };
  /** Once merged: what the base branch has that its upstream doesn't (to push). */
  unpushed?: { base: string; remote: string; count: number };
  /** The model and effort agents use when the ticket doesn't choose (the settings; unset: Claude Code's defaults). */
  agentDefaults: AgentChoice;
  /** The model Light tickets' work runs on (flotilla.agents.lightModel); unset: no ticket can be Light. */
  lightModel?: string;
  /** When a working agent looks stuck (flotilla.agents.stuck.*); unset: the defaults. */
  stuckRules?: StuckRules;
  /** Whether the user keeps Flotilla's notes (the activity timeline) open. */
  showActivity: boolean;
  /** Its attachments (BL-110), newest first: the Attachments section above the activity. None: no section. */
  attachments?: AttachmentView[];
  /** The user folded its Attachments section (remembered per ticket). */
  attachmentsFolded?: boolean;
  /** It can be discussed with an agent (a proposal, or To Do): Discuss starts that (BL-45). */
  canDiscuss: boolean;
  /** The tickets its description says it depends on ("Depends on: BL-12"), with their status: it waits for those not done. */
  dependsOn: Array<{ id: string; title: string; status: BacklogStatus }>;
  /** Main can be merged into its branch from here (Update from Main): it's open and has a worktree. base: main's name. */
  updateFromMain?: { base: string };
  /** Its discussion with an agent: whether the agent is replying now, and whether it says the ticket is ready to start. */
  shaping?: {
    agent: string;
    running: boolean;
    ready: boolean;
    /** The user paused or stopped it: Resume goes on in its chat. */
    held?: 'paused' | 'stopped';
    /** It's a Claude Code chat (BL-188): open (Discussing), or closed, or its first message not sent yet (pending). */
    chat?: 'open' | 'closed' | 'pending';
  };
  /**
   * Its last Check (BL-163): each thing it says is going on, ✓ (ok, with its evidence) or ✗ (with what Clean Up does).
   * full: the user clicked Check (all claims shown); else the check made on opening it, which shows only glitches.
   */
  check?: TicketCheckView;
}

export interface TicketCheckView {
  full: boolean;
  /** When it checked (HH:MM). */
  at: string;
  claims: Array<{ key: string; ok: boolean; text: string; fix?: string }>;
  /** It couldn't check (no process list, say). */
  error?: string;
}

/** The top-level parts of a view that a change sends on their own (the activity has its own: see TicketPartsMessage). */
export type TicketPart = Exclude<keyof TicketView, 'activity'>;

export type TicketHostMessage =
  | { type: 'ticket'; ticket: TicketView }
  /**
   * What changed since the view sent before (see ticketUpdate): the parts that differ, and those that are gone. The
   * activity keeps its first `keep` entries and gets `entries` after them.
   */
  | {
      type: 'ticketParts';
      parts: Partial<Pick<TicketView, TicketPart>>;
      removed: TicketPart[];
      activity?: { keep: number; entries: TicketView['activity'] };
    }
  /** An action (the webview's message, as it was sent) is finished, its view posted: failed if it threw. */
  | { type: 'done'; message: TicketWebviewMessage; failed?: boolean }
  /** Puts the cursor in the comment box (a ticket opened to answer a question, or to request changes). */
  /** The comment box, or the Demo section (BL-135). */
  | { type: 'focus'; target: 'comment' | 'demo' }
  /** An image was saved next to the ticket; markdown links it. */
  | { type: 'imageSaved'; requestId: number; markdown: string }
  /** A Markdown box's Preview (BL-129): its text rendered as the activity shows it. */
  | { type: 'previewed'; requestId: number; html: string }
  /** The Ask chat changed (BL-80). */
  | { type: 'ask'; ask: AskView }
  /** Its CI changed (BL-106): sent on its own, as it's read (every 10 seconds while a run goes on). */
  | { type: 'ci'; ci: TicketCiView }
  /** A run's whole log, for Show All (BL-169). */
  | { type: 'checksLog'; requestId: number; text: string };

export type TicketPartsMessage = Extract<TicketHostMessage, { type: 'ticketParts' }>;

export type TicketWebviewMessage =
  | { type: 'ready' }
  | { type: 'title'; title: string }
  | { type: 'description'; text: string }
  /** replyTo: the anchor of the entry it answers (BL-126). */
  | { type: 'comment'; text: string; replyTo?: string }
  | { type: 'status'; status: BacklogStatus }
  /** null clears it. */
  | { type: 'priority'; priority: BacklogPriority | null }
  /** A pasted or dropped image or video, base64. */
  | { type: 'image'; requestId: number; name: string; data: string }
  /** A pasted or dropped file over its kind's size limit, not sent (the host says so). */
  | { type: 'mediaRefused'; name: string; kind: MediaKind; size: number }
  /** Renders a Markdown box's text for its Preview tab (BL-129); answered with previewed. */
  | { type: 'preview'; requestId: number; text: string }
  /** Create (or show) the item's worktree; with agent, also start an agent there. */
  | { type: 'start'; agent: boolean; /** The Create Worktree button: a new worktree at once, named without asking or in a box. */ newWorktree?: 'auto' | 'named' }
  /** Discuss the ticket with an agent (BL-45), without a comment first; Keep discussing dismisses "ready to start". */
  | { type: 'discuss' }
  | { type: 'keepDiscussing' }
  | { type: 'openFile' }
  | { type: 'openRemote' }
  /** Link the item to an issue (asks which), unlink it, or open a linked one. */
  | { type: 'link' }
  | { type: 'unlink'; id: string }
  | { type: 'openLink'; id: string }
  | { type: 'openWorktree'; key: string }
  /** Move an issue in its tracker's workflow. */
  | { type: 'transition'; id: string }
  /** Set an issue's priority, by the tracker's name for it. */
  | { type: 'remotePriority'; name: string }
  /** Post a local activity entry (an agent's report) to an issue, after asking. */
  | { type: 'postEntry'; key: string }
  /** Create an issue for a local item in a connected tracker, and link it. */
  | { type: 'createIssue' }
  /** Accept or dismiss an agent's proposal; open another ticket (a parent, a sub-ticket). */
  | { type: 'startReview' }
  /** The user's own review: approve, or request changes (an agent picks them up). */
  | { type: 'userReview'; verdict: 'approved' | 'changes'; text: string }
  | { type: 'stopReview' }
  /** Pause, stop or resume an agent: the one with that chat, else the one working on it. */
  | { type: 'agent'; action: 'pause' | 'stop' | 'resume'; session?: string }
  /** Merge main into its branch, or have its agent do it when that conflicts (BL-55). */
  | { type: 'updateFromMain' }
  /** Check what the ticket says is going on (BL-163); Clean Up its glitches (one, by key, or all). */
  | { type: 'check' }
  | { type: 'checkCleanUp'; key?: string }
  /** Fix with Agent on the red CI Merge to main stopped on (BL-112). */
  | { type: 'mergeCiFix' }
  /** Fix a stopped review: go on, hand it to a new agent, give it in the implementer's chat… */
  | { type: 'reviewFix'; fix: ReviewFix }
  /** The queued start of this ticket: start it now (see ReviewLoop.prioritize). */
  | { type: 'prioritize' }
  | { type: 'accept' }
  | { type: 'dismiss' }
  | { type: 'openTicket'; id: string }
  /** A link in a description or an entry: a file in the repository (path#L10-L20), or a web page. */
  | { type: 'openHref'; href: string }
  /** The model and effort agents use on it: null is the default; 'other' asks for a model's name. */
  | { type: 'agentModel'; model: string | null }
  | { type: 'agentEffort'; effort: AgentEffort | null }
  /** Open an agent's chat in Claude Code. */
  | { type: 'openChat'; key: string; id: string }
  /** Summarize a working agent's status with a small model (BL-180): at most once a minute per agent. */
  | { type: 'summarize'; session: string }
  /** Open what a commit changed. */
  | { type: 'openCommit'; hash: string }
  /** Clean up the history of its branch; and the clean-up's actions. */
  | { type: 'cleanUp' }
  | { type: 'finishCleanUp' }
  | { type: 'cancelCleanUp' }
  | { type: 'compareCleanUp' }
  /** Merge it into the base branch; a merge's decisions; push the base branch after. */
  | { type: 'merge' }
  | { type: 'mergeResolve' }
  | { type: 'mergeApprove' }
  | { type: 'mergeRecheck' }
  | { type: 'mergeCancel' }
  /** Stop waiting for CI to pass (BL-105): nothing is merged. */
  | { type: 'mergeCiCancel' }
  /** A merge's checks (BL-169): Stop them; the whole log of a run (Show All); the log, followed, in a terminal. */
  | { type: 'mergeChecksStop' }
  | { type: 'mergeChecksLog'; requestId: number; log: string }
  | { type: 'mergeChecksTerminal'; log: string }
  | { type: 'mergeQueueRemove' }
  /** Resolve its conflicts with the tickets ahead of it in the merge train, in its merge there (BL-146). */
  | { type: 'mergeQueueResolve' }
  /** Merge Next (BL-144): to the front of the merge queue. */
  | { type: 'mergeNext' }
  | { type: 'push' }
  /** Create a worktree for a branch of the item that has none. */
  | { type: 'checkout'; branch: string }
  /** Done with unmerged work: a sibling ticket to merge a branch (asks which, unless given); or dismiss the warning. */
  | { type: 'mergeSibling'; branch?: string }
  | { type: 'dismissUnmerged' }
  /** Run a run block of an agent's report (after asking): the Run buttons. */
  /** try: a demo block's window set up as the demo starts, its steps not played (Try it yourself, BL-135). */
  | { type: 'run'; key: string; index: number; try?: boolean }
  /** Keeps Flotilla's notes open (or shut) for the user, from now on. */
  | { type: 'showActivity'; shown: boolean }
  /** Folds (or opens) the ticket's Attachments section, for this ticket from now on. */
  | { type: 'foldAttachments'; folded: boolean }
  /** The Ask chat (BL-80): a question, stop the answer, start over, post an answer to the ticket as a comment. */
  | { type: 'ask'; text: string }
  | { type: 'askStop' }
  | { type: 'askNew' }
  | { type: 'askPost'; index: number }
  /** Its CI (BL-106): the CI/CD view's requests for a worktree of the ticket; open or close it; show the CI/CD view. */
  | ({ type: 'ci' } & CiRequest)
  | { type: 'ciOpen'; open: boolean }
  | { type: 'ciShow'; key: string };
