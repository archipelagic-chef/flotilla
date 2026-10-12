/**
 * Messages between the extension host and a ticket editor tab. Type-only: imported by both sides, so it must not
 * import vscode, node or DOM APIs.
 */
import type { AgentChoice, AgentEffort, BacklogItem, BacklogPriority, BacklogStatus } from '../features/backlog/backlog';
import type { RemoteEditOptions } from '../features/backlog/sources/source';
import type { HistoryRewrite, HistoryVersion } from '../features/backlog/history';
import type { ReviewFix, ReviewState } from '../features/backlog/review';
import type { TicketEntry } from '../features/backlog/ticket';
import type { RunBlockRef } from '../features/backlog/runBlocks';
import type { AttentionState } from '../features/workstreams/attention';
import type { TicketCommit } from '../features/history/log';

/** An agent's chat, as a ticket entry links it: click to open it in Claude Code. */
export type AgentChatView =
  | {
      key: string;
      id: string;
      /** The agent's short name, which its reports are signed with ("a3f9"). */
      agent: string;
      title: string;
      state: 'working' | 'waiting-for-input' | 'done' | 'ended';
      /** What it asks, while it waits for you. */
      message?: string;
      branch: string;
      /** ISO 8601. */
      started: string;
      updated: string;
      /** The model and effort it ran with (its last reply's; before that, what it was started with). */
      model?: string;
      effort?: string;
    }
  /** Started, but Claude Code hasn't created the chat yet (its first message isn't sent). */
  | { pending: true; agent: string; headless?: boolean };

export interface TicketView {
  item: BacklogItem;
  /** Markdown, for editing. */
  description: string;
  descriptionHtml: string;
  /** key: a local entry (a comment or an agent's report), which can be posted to an issue; posted: to which. */
  activity: Array<TicketEntry & { html: string; key?: string; posted?: string; chat?: AgentChatView }>;
  /** For an issue from an integration: where it lives, and what can be changed from here (as its tracker allows). */
  remote?: {
    kind: 'jira' | 'github';
    label: string;
    url: string;
    statusName: string;
    priorityName?: string;
    edit?: RemoteEditOptions;
  };
  /** The agents that worked on it (their chats), oldest first, with how many reports each wrote. */
  agents: Array<Exclude<AgentChatView, { pending: true }> & { reports: number }>;
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
  /** The model and effort agents use when the ticket doesn't choose (the settings; unset: Claude Code's defaults). */
  agentDefaults: AgentChoice;
}

export type TicketHostMessage =
  | { type: 'ticket'; ticket: TicketView }
  /** Puts the cursor in the comment box (a ticket opened to answer a question, or to request changes). */
  | { type: 'focus'; target: 'comment' }
  /** An image was saved next to the ticket; markdown links it. */
  | { type: 'imageSaved'; requestId: number; markdown: string };

export type TicketWebviewMessage =
  | { type: 'ready' }
  | { type: 'title'; title: string }
  | { type: 'description'; text: string }
  | { type: 'comment'; text: string }
  | { type: 'status'; status: BacklogStatus }
  /** null clears it. */
  | { type: 'priority'; priority: BacklogPriority | null }
  /** A pasted or dropped image, base64. */
  | { type: 'image'; requestId: number; name: string; data: string }
  /** Create (or show) the item's worktree; with agent, also start an agent there. */
  | { type: 'start'; agent: boolean }
  | { type: 'writeWithAI' }
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
  /** Fix a stopped review: go on, hand it to a new agent, give it in the implementer's chat… */
  | { type: 'reviewFix'; fix: ReviewFix }
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
  /** Open what a commit changed. */
  | { type: 'openCommit'; hash: string }
  /** Clean up the history of its branch; and the clean-up's actions. */
  | { type: 'cleanUp' }
  | { type: 'finishCleanUp' }
  | { type: 'cancelCleanUp' }
  | { type: 'compareCleanUp' }
  /** Create a worktree for a branch of the item that has none. */
  | { type: 'checkout'; branch: string }
  /** Run a run block of an agent's report (after asking): the Run buttons. */
  | { type: 'run'; key: string; index: number };
