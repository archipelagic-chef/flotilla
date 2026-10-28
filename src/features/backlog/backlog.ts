import type { PullRequestInfo, PullRequestReview } from '../ci/pullRequests';
import type { PushedInfo } from './branchPush';
import type { HistoryRewrite, HistoryVersion } from './history';
import type { MainCheck } from './mainDrift';
import type { MergedInfo, MergeState } from './merge';
import type { MergeTrain } from './mergeTrain';
import type { ReviewState } from './review';
import type { SisterCheck, SisterVerdict } from './sisterCheck';
/**
 * The backlog: work items in priority order, each to do, in progress or done. Items come from a source: the local
 * backlog (below) to begin with; Jira and GitHub Issues can be added as sources with the same item shape.
 */
/** To do, in progress, in review (done, waiting for someone to look at it), done. */
export type BacklogStatus = 'todo' | 'doing' | 'review' | 'done';

/** How important an item is; unset means not decided. */
export type BacklogPriority = 'urgent' | 'high' | 'medium' | 'low';

export const BACKLOG_PRIORITIES: readonly BacklogPriority[] = ['urgent', 'high', 'medium', 'low'];

/** A tracker's priority name ("Highest", "P1", "priority: low") as a backlog priority. */
export function priorityFromName(name: string | undefined): BacklogPriority | undefined {
  const n = (name ?? '').toLowerCase();
  if (/highest|blocker|critical|urgent|\bp0\b/.test(n)) return 'urgent';
  if (/high|major|\bp1\b/.test(n)) return 'high';
  if (/medium|normal|\bp2\b/.test(n)) return 'medium';
  if (/lowest|low|minor|trivial|\bp[34]\b/.test(n)) return 'low';
  return undefined;
}

export interface BacklogItem {
  /** Ticket-like id, e.g. "BL-12"; branches started from the item carry it, which links them. */
  id: string;
  title: string;
  notes?: string;
  status: BacklogStatus;
  priority?: BacklogPriority;
  /** ISO 8601. */
  created: string;
  /** Branches started for it: one for a small item, several for an epic. */
  branches?: string[];
  /** Before branches: the one branch started for it. Read, never written. */
  branch?: string;
  /** Issues in trackers (Jira, GitHub Issues) this item is linked to. */
  links?: IssueLink[];
  /** The item it's a part of (an epic, or a task an agent broke down). */
  parent?: string;
  /** Added by an agent and not accepted yet (by: the agent's name, when it signed). */
  proposed?: { by?: string };
  /** Its review loop (a reviewer agent, rounds, verdict), once it has been in review. */
  review?: ReviewState;
  /** Discarded as "won't do" (BL-209), when (ISO 8601): kept with its ticket, out of the lanes, until it's reopened. */
  discarded?: { at: string };
  /** Done with work left unmerged, dismissed as superseded by this item (its id). */
  supersededBy?: string;
  /** An epic you moved out of Done with all its parts done: it stays out until another of its parts finishes (BL-206). */
  keptOpen?: boolean;
  /** An epic you moved back to To Do with parts started: it stays there until another of its parts starts (BL-239). */
  keptToDo?: boolean;
  /** Its description's fingerprint when last seen: a change to it (in the ticket file) is noted in its activity. */
  descriptionHash?: string;
  /** The model and effort agents use on it (unset: the settings'). */
  agent?: AgentChoice;
  /**
   * The discussion of a ticket nobody works on yet (BL-45): the shaping agent's name and chat, and whether it thinks
   * the ticket is ready to start (until the user writes again, or keeps discussing).
   */
  shaping?: {
    agent: string;
    /** Its chat's session; "" for a discussion chat whose first message isn't sent yet (found by it, see findDiscussionChat). */
    session: string;
    /** The discussion is a Claude Code chat the owner talks in (BL-188), not replies in the ticket: when it opened ("YYYY-MM-DD HH:MM"). */
    chat?: { since: string };
    ready?: boolean;
    /** The user paused (or stopped) it, when (ISO 8601): it goes on in its chat when they resume it, or write again. */
    held?: { kind: 'paused' | 'stopped'; at: string };
  };
  /** Its branches merged with main in memory, last time either moved (BL-55): whether they conflict, and where. */
  mainCheck?: MainCheck;
  /** A clean-up of its commit history in progress, and the histories kept from earlier clean-ups (oldest first). */
  rewrite?: HistoryRewrite;
  history?: HistoryVersion[];
  /** Agents' replies to your comments (Ask an Agent, BL-127) that came while its ticket wasn't open: its card says so until it's opened. */
  unseenReplies?: number;
  /** The autopilot couldn't start an agent on it (why, and when): it waits for the user to start it (Run). */
  startFailed?: { message: string; /** ISO 8601. */ since: string };
  /** A merge of its branch waiting for a decision (its conflicts being resolved), and where it was merged once done. */
  merging?: MergeState;
  merged?: MergedInfo;
  /** Its sisters' check (BL-236): waiting a few minutes after its change, or running. */
  sisterCheck?: SisterCheck;
  /** A sister's check found it covered by that ticket's change, or at odds with it: "Needs you" asks Discard or Keep. */
  sisterVerdict?: SisterVerdict;
  /** Its branches' last pushes to origin once approved (BL-104): a tip is pushed, and noted, once. */
  pushed?: PushedInfo[];
  /** Its branches' pull requests on GitHub (BL-221), opened once they're pushed for review, with their last known state. */
  pullRequests?: PullRequestInfo[];
  /** Its reviewer agents' review rounds, posted on its open pull requests (BL-223). */
  pullRequestReviews?: PullRequestReview[];
  /** Since when (ISO 8601) a pull request couldn't be opened for it because you aren't signed in to GitHub (BL-232). */
  pullRequestSignIn?: string;
}

/** How hard an agent thinks (Claude Code's --effort). */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Which model an agent runs, and how hard it thinks: unset, Claude Code's default. */
export interface AgentChoice {
  /** An alias ("opus", "sonnet") or a model's full name. */
  model?: string;
  effort?: AgentEffort;
  /** A ticket's: small and mechanical, its work runs on flotilla.agents.lightModel (see modelLevel.ts). */
  light?: boolean;
  /** A ticket's: it moved up to the strong model (from what, to what, why, when: ISO 8601). */
  movedUp?: { from: string; to: string; reason: string; at: string };
}

/** A local item's link to an issue in a tracker. */
export interface IssueLink {
  /** The issue's key: "ABC-123", "GH-42". */
  id: string;
  /** The integration it comes from. */
  source: string;
  url: string;
  /** As it was when linked; the tracker's current title shows while it's connected. */
  title: string;
}

export interface BacklogData {
  version: 1;
  /** Before counters: the number the next item got. Kept, no longer used. */
  next: number;
  /** The highest number given out per prefix (numbers aren't reused after a delete). */
  counters?: Record<string, number>;
  /** The prefix last chosen for a new item; new items get it until another is chosen. */
  prefix?: string;
  /** In priority order (first is most important), across statuses. */
  items: BacklogItem[];
  /** The merge queue (BL-140): the ids of the tickets waiting to land, in the order they land. */
  mergeQueue?: string[];
  /** The train built from the queue, as last built. */
  mergeTrain?: MergeTrain;
}

export const EMPTY_BACKLOG: BacklogData = { version: 1, next: 1, items: [] };

export const BACKLOG_STATUSES: readonly BacklogStatus[] = ['todo', 'doing', 'review', 'done'];

/**
 * The lanes of the backlog: the statuses, with In Review split. An item in review whose review is approved waits to be
 * merged (Ready to Merge); nothing about that is stored.
 */
export type BacklogLane = BacklogStatus | 'ready';

export const BACKLOG_LANES: readonly BacklogLane[] = ['todo', 'doing', 'review', 'ready', 'done'];

/** An item's lane; a discarded item is in none (BL-209). */
export function laneOf(item: Pick<BacklogItem, 'status' | 'review' | 'discarded'>): BacklogLane | undefined {
  if (item.discarded) return undefined;
  return item.status === 'review' && item.review?.state === 'approved' ? 'ready' : item.status;
}

export function isBacklogData(value: unknown): value is BacklogData {
  const v = value as BacklogData;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.version === 1 &&
    Number.isInteger(v.next) &&
    Array.isArray(v.items) &&
    v.items.every((i) => typeof i?.id === 'string' && typeof i.title === 'string' && BACKLOG_STATUSES.includes(i.status))
  );
}

/** Ids look like tickets: a prefix of letters and digits, a dash, a number ("BL-12", "WEB-3"). */
export const ID_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})$/;

/** The next id for a prefix: one past the highest given out or in use. */
export function nextId(data: BacklogData, prefix: string, taken: readonly string[] = []): string {
  const used = [...data.items.map((i) => i.id), ...taken]
    .map((id) => ID_PATTERN.exec(id))
    .filter((m): m is RegExpExecArray => m !== null && m[1].toUpperCase() === prefix.toUpperCase())
    .map((m) => Number(m[2]));
  return `${prefix}-${Math.max(data.counters?.[prefix.toUpperCase()] ?? 0, ...used, 0) + 1}`;
}

/** The prefix for new items: the one last chosen, else the setting's. */
export function currentPrefix(data: BacklogData, setting: string): string {
  return data.prefix ?? (setting.trim() || 'BL');
}

/**
 * What's typed to add an item: its title, optionally after an id ("WEB-12 Fix login") or a prefix for its next number
 * ("WEB- Fix login"). Without either, the item gets the next number for the current prefix.
 */
export function parseNewItem(
  text: string,
  data: BacklogData,
  prefix: string,
  taken: readonly string[] = [],
): { id: string; prefix: string; title: string; chosen: boolean; problem?: string } {
  const m = /^\s*([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})?(?=[\s:]|$)[\s:]*([\s\S]*)$/.exec(text);
  if (!m) return { id: nextId(data, prefix, taken), prefix, title: text.trim(), chosen: false };
  const p = m[1].toUpperCase();
  const title = m[3].trim();
  if (!m[2]) return { id: nextId(data, p, taken), prefix: p, title, chosen: false };
  const id = `${p}-${Number(m[2])}`;
  return { id, prefix: p, title, chosen: true, problem: idProblem(data, id, taken) };
}

/** Why an id can't be used for a new item, if it can't. */
export function idProblem(data: BacklogData, id: string, taken: readonly string[] = []): string | undefined {
  if (!ID_PATTERN.test(id)) return 'An id is a prefix, a dash and a number, like BL-12.';
  const lower = id.toLowerCase();
  if ([...data.items.map((i) => i.id), ...taken].some((t) => t.toLowerCase() === lower)) return `${id} is already taken.`;
  return undefined;
}

/**
 * Adds an item at the top of To do (newest ideas start out most visible; drag to reprioritize), with the given id or
 * the next one for prefix.
 */
export function addItem(data: BacklogData, title: string, prefix: string, now: Date, id = nextId(data, prefix)): { data: BacklogData; item: BacklogItem } {
  const problem = idProblem(data, id);
  if (problem) throw new Error(problem);
  const item: BacklogItem = { id, title: title.trim(), status: 'todo', created: now.toISOString() };
  const [, p, n] = ID_PATTERN.exec(id)!;
  const key = p.toUpperCase();
  const counters = { ...data.counters, [key]: Math.max(data.counters?.[key] ?? 0, Number(n)) };
  return { data: { ...data, counters, items: [item, ...data.items] }, item };
}

export function updateItem(
  data: BacklogData,
  id: string,
  change: Partial<Pick<BacklogItem, 'title' | 'notes' | 'status' | 'branches' | 'shaping'>> & { priority?: BacklogPriority | null },
): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      const { priority, ...rest } = change;
      const next: BacklogItem = { ...i, ...rest };
      // null clears the priority.
      if (priority === null) delete next.priority;
      else if (priority) next.priority = priority;
      return next;
    }),
  };
}

/** Whether an item is ready to merge: in review, approved, and not being merged already. */
export function readyToMerge(item: Pick<BacklogItem, 'status' | 'review' | 'proposed' | 'merging' | 'discarded'>): boolean {
  return item.status === 'review' && item.review?.state === 'approved' && !item.proposed && !item.merging && !item.discarded;
}

/** Accepts an agent's proposed item: it becomes an ordinary one. */
export function acceptItem(data: BacklogData, id: string): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      // The owner accepted it: its discussion is over (Discuss starts a new one for a To Do), and the autopilot takes it.
      const { proposed: _p, shaping: _s, ...rest } = i;
      return rest;
    }),
  };
}

/** The items that are parts of an item, in backlog order. */
export function childrenOf(data: BacklogData, id: string): BacklogItem[] {
  return data.items.filter((i) => i.parent === id);
}

/**
 * The backlog with its finished epics moved to Done (BL-206), and which moved with their parts: an item with parts,
 * every one of them done (an open proposal among them holds it; a dismissed one is gone). before is the backlog as it
 * was before next: an epic moved out of Done there with its parts all done is kept out (keptOpen) until another of its
 * parts finishes. Epics of epics close in turn.
 */
export function closeFinishedEpics(before: BacklogData, next: BacklogData): { data: BacklogData; closed: Array<{ id: string; parts: string[] }> } {
  const was = new Map(before.items.map((i) => [i.id, i]));
  const closed: Array<{ id: string; parts: string[] }> = [];
  let items = next.items;
  for (let changed = true; changed;) {
    changed = false;
    const data = { ...next, items };
    items = items.map((item) => {
      const parts = childrenOf(data, item.id);
      if (!parts.length || item.proposed || !parts.every((p) => p.status === 'done' && !p.proposed)) return item;
      const finished = parts.some((p) => was.get(p.id)?.status !== 'done');
      if (item.status === 'done') return item;
      if (!finished && was.get(item.id)?.status === 'done') return item.keptOpen ? item : { ...item, keptOpen: true };
      if (!finished && item.keptOpen) return item;
      const { keptOpen: _k, ...rest } = item;
      changed = true;
      closed.push({ id: item.id, parts: parts.map((p) => p.id) });
      return { ...rest, status: 'done' };
    });
  }
  return { data: { ...next, items }, closed };
}

/** Whether a part counts as started for its epic (BL-239): in progress, in review or done, accepted and not discarded. */
const started = (i: BacklogItem | undefined) => !!i && i.status !== 'todo' && !i.proposed && !i.discarded;

/**
 * The backlog with its started epics moved to In Progress (BL-239), and which moved with the part that did it: a To Do
 * item with parts, one of them started. before is the backlog as it was before next: an epic moved back to To Do there
 * with no part newly started is kept there (keptToDo) until another of its parts starts. Epics of epics start in turn.
 */
export function startEpics(before: BacklogData, next: BacklogData): { data: BacklogData; started: Array<{ id: string; part: string }> } {
  const was = new Map(before.items.map((i) => [i.id, i]));
  const moved: Array<{ id: string; part: string }> = [];
  let items = next.items;
  for (let changed = true; changed;) {
    changed = false;
    const data = { ...next, items };
    items = items.map((item) => {
      if (item.status !== 'todo' && item.keptToDo) {
        const { keptToDo: _k, ...rest } = item;
        return rest;
      }
      if (item.status !== 'todo' || item.proposed || item.discarded) return item;
      const parts = childrenOf(data, item.id).filter(started);
      if (!parts.length) return item;
      const fresh = parts.find((p) => !started(was.get(p.id)));
      const old = was.get(item.id);
      if (!fresh && old && old.status !== 'todo') return item.keptToDo ? item : { ...item, keptToDo: true };
      if (!fresh && item.keptToDo) return item;
      const { keptToDo: _k, ...rest } = item;
      changed = true;
      moved.push({ id: item.id, part: (fresh ?? parts[0]).id });
      return { ...rest, status: 'doing' };
    });
  }
  return { data: { ...next, items }, started: moved };
}

export function removeItem(data: BacklogData, id: string): BacklogData {
  return { ...data, items: data.items.filter((i) => i.id !== id) };
}

/** Discards an item as "won't do" (BL-209): its status and ticket are kept, and it leaves the lanes until it's reopened. */
export function discardItem(data: BacklogData, id: string, at: string): BacklogData {
  const queue = data.mergeQueue?.filter((q) => q !== id);
  return {
    ...data,
    ...(queue ? { mergeQueue: queue } : {}),
    // A sister check's question (BL-236) is answered by the discard.
    items: data.items.map((i) => {
      if (i.id !== id || i.discarded) return i;
      const { sisterVerdict: _asked, ...rest } = i;
      return { ...rest, discarded: { at } };
    }),
  };
}

/** Reopens a discarded item: it goes back to To Do, or the status picked (the ticket's status bar, BL-231). */
export function reopenItem(data: BacklogData, id: string, status: BacklogStatus = 'todo'): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id || !i.discarded) return i;
      const { discarded: _d, ...rest } = i;
      return { ...rest, status };
    }),
  };
}

/** Records that the autopilot couldn't start an item (with why), or clears that record (without a failure). */
export function setStartFailed(data: BacklogData, id: string, failed?: { message: string; since: string }): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      const { startFailed: _old, ...rest } = i;
      return failed ? { ...rest, startFailed: failed } : rest;
    }),
  };
}

/** Moves an item before another one (or to the end), and into a status: drag and drop between and within lanes. */
export function moveItem(data: BacklogData, id: string, status: BacklogStatus, before?: string): BacklogData {
  const item = data.items.find((i) => i.id === id);
  if (!item || id === before) return data;
  const rest = data.items.filter((i) => i.id !== id);
  const at = before === undefined ? -1 : rest.findIndex((i) => i.id === before);
  const moved = { ...item, status };
  // Without a target, it goes after the last item of its new lane (or at the end).
  const lastInLane = rest.reduce((last, i, n) => (i.status === status ? n : last), -1);
  const index = at >= 0 ? at : lastInLane >= 0 ? lastInLane + 1 : rest.length;
  return { ...data, items: [...rest.slice(0, index), moved, ...rest.slice(index)] };
}

/** Links an item to an issue (again: a link to the same issue is replaced). */
export function linkIssue(data: BacklogData, id: string, link: IssueLink): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => (i.id === id ? { ...i, links: [...(i.links ?? []).filter((l) => l.id !== link.id), link] } : i)),
  };
}

export function unlinkIssue(data: BacklogData, id: string, issue: string): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      const { links, ...rest } = i;
      const kept = (links ?? []).filter((l) => l.id !== issue);
      return kept.length ? { ...rest, links: kept } : rest;
    }),
  };
}

/** The local item an issue is linked to, if any. */
export function linkedItem(data: BacklogData, issue: string): BacklogItem | undefined {
  return data.items.find((i) => i.links?.some((l) => l.id === issue));
}

/** A branch name for an item, from a pattern with {id} and {slug} (the title, lower case, dashes). */
export function branchFor(item: Pick<BacklogItem, 'id' | 'title'>, pattern: string): string {
  const slug = item.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return pattern
    .replace(/\{id\}/g, item.id)
    .replace(/\{slug\}/g, slug || 'work')
    .replace(/-{2,}/g, '-')
    .replace(/[-/]+$/, '');
}

/** The branches started for an item (including the one older backlogs recorded). */
export function itemBranches(item: Pick<BacklogItem, 'branches' | 'branch'>): string[] {
  return [...new Set([...(item.branches ?? []), ...(item.branch ? [item.branch] : [])])];
}

/** Records a branch started for an item (an epic gets several). */
export function addBranch(data: BacklogData, id: string, branch: string): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      const { branch: _old, ...rest } = i;
      return { ...rest, branches: [...new Set([...itemBranches(i), branch])] };
    }),
  };
}

/** Whether a worktree's branch works on an item: one started for it, or one whose name carries its id. */
export function branchMatches(item: Pick<BacklogItem, 'id' | 'branches' | 'branch' | 'links'>, branch: string): boolean {
  if (itemBranches(item).includes(branch)) return true;
  // A branch named after a linked issue ("feature/ABC-123-…") works on the item too.
  return [item.id, ...(item.links ?? []).map((l) => l.id)].some((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, 'i').test(branch);
  });
}

/**
 * The first line of an agent's chat: it names the item and the agent (a short name, "a3f9", that it signs its
 * reports in the ticket with). That's how a ticket finds its agents' chats, and which chat wrote which report.
 */
export function agentLead(item: Pick<BacklogItem, 'id' | 'title'>, agent: string): string {
  // Names first: Flotilla reads only the start of a chat's first message.
  return `You are agent ${agent}, working on backlog item ${item.id}: "${item.title}".`;
}

/** The item and agent name an agent chat was started for, from its first message. */
export function agentChatItem(firstPrompt: string | undefined): { item: string; agent: string } | undefined {
  const m = /^You are agent ([A-Za-z0-9-]+), working on backlog item ([A-Za-z0-9_-]+)/.exec(firstPrompt?.trim() ?? '');
  return m ? { agent: m[1], item: m[2] } : undefined;
}

/** The agent name of a ticket entry's author ("Agent Nova-7"), as written; undefined for others (and "Agent" alone). */
export function entryAgent(author: string): string | undefined {
  return /^agent\s+([A-Za-z0-9][A-Za-z0-9-]*)$/i.exec(author.trim())?.[1];
}

/** Whether two agent names are the same agent ("Nova-7", "nova-7"). */
export function sameAgent(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Names for agents: short and friendly, robot-like with their number ("Nova-7"), so they're easy to tell apart. */
export const AGENT_NAMES = [
  'Ada',
  'Astro',
  'Atlas',
  'Bolt',
  'Byte',
  'Cog',
  'Comet',
  'Cosmo',
  'Dash',
  'Dex',
  'Echo',
  'Ember',
  'Flux',
  'Gizmo',
  'Halo',
  'Hex',
  'Ion',
  'Iris',
  'Jet',
  'Juno',
  'Kit',
  'Lumen',
  'Mica',
  'Neon',
  'Nova',
  'Onyx',
  'Orbit',
  'Pip',
  'Pixel',
  'Quill',
  'Rex',
  'Rivet',
  'Rune',
  'Sage',
  'Servo',
  'Spark',
  'Sprocket',
  'Tango',
  'Tesla',
  'Tink',
  'Vega',
  'Volt',
  'Watt',
  'Wren',
  'Zephyr',
  'Ziggy',
  'Zinc',
];

/**
 * The name of a chat Flotilla didn't start, from its session id (the same everywhere: the hook computes it too, see
 * hookScript.ts, which must stay in step with this).
 */
export function sessionAgentName(sessionId: string): string {
  let h = 0;
  for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${AGENT_NAMES[h % AGENT_NAMES.length]}-${1 + (Math.floor(h / AGENT_NAMES.length) % 9)}`;
}

/** A new agent's name, not one of taken (the repository's other agents). random: [0, 1), injectable for tests. */
export function agentName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${AGENT_NAMES[Math.floor(random() * AGENT_NAMES.length)]}-${1 + Math.floor(random() * 9)}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  // Hundreds of agents: numbers grow.
  for (let n = 10; ; n++) {
    const name = `${AGENT_NAMES[n % AGENT_NAMES.length]}-${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}
