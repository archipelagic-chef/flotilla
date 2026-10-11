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
}

export const EMPTY_BACKLOG: BacklogData = { version: 1, next: 1, items: [] };

export const BACKLOG_STATUSES: readonly BacklogStatus[] = ['todo', 'doing', 'review', 'done'];

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
  change: Partial<Pick<BacklogItem, 'title' | 'notes' | 'status' | 'branches'>> & { priority?: BacklogPriority | null },
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

/** Accepts an agent's proposed item: it becomes an ordinary one. */
export function acceptItem(data: BacklogData, id: string): BacklogData {
  return {
    ...data,
    items: data.items.map((i) => {
      if (i.id !== id) return i;
      const { proposed: _p, ...rest } = i;
      return rest;
    }),
  };
}

/** The items that are parts of an item, in backlog order. */
export function childrenOf(data: BacklogData, id: string): BacklogItem[] {
  return data.items.filter((i) => i.parent === id);
}

export function removeItem(data: BacklogData, id: string): BacklogData {
  return { ...data, items: data.items.filter((i) => i.id !== id) };
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
  return pattern.replace(/\{id\}/g, item.id).replace(/\{slug\}/g, slug || 'work').replace(/-{2,}/g, '-').replace(/[-/]+$/, '');
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
const AGENT_NAMES = [
  'Ada', 'Astro', 'Atlas', 'Bolt', 'Byte', 'Cog', 'Comet', 'Cosmo', 'Dash', 'Dex', 'Echo', 'Ember', 'Flux', 'Gizmo',
  'Halo', 'Hex', 'Ion', 'Iris', 'Jet', 'Juno', 'Kit', 'Lumen', 'Mica', 'Neon', 'Nova', 'Onyx', 'Orbit', 'Pip',
  'Pixel', 'Quill', 'Rex', 'Rivet', 'Rune', 'Sage', 'Servo', 'Spark', 'Sprocket', 'Tango', 'Tesla', 'Tink', 'Vega',
  'Volt', 'Watt', 'Wren', 'Zephyr', 'Ziggy', 'Zinc',
];

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
