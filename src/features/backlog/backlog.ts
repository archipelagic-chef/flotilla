/**
 * The backlog: work items in priority order, each to do, in progress or done. Items come from a source: the local
 * backlog (below) to begin with; Jira and GitHub Issues can be added as sources with the same item shape.
 */
export type BacklogStatus = 'todo' | 'doing' | 'done';

export interface BacklogItem {
  /** Ticket-like id, e.g. "BL-12"; branches started from the item carry it, which links them. */
  id: string;
  title: string;
  notes?: string;
  status: BacklogStatus;
  /** ISO 8601. */
  created: string;
  /** Branches started for it: one for a small item, several for an epic. */
  branches?: string[];
  /** Before branches: the one branch started for it. Read, never written. */
  branch?: string;
}

export interface BacklogData {
  version: 1;
  /** The number the next item gets. */
  next: number;
  /** In priority order (first is most important), across statuses. */
  items: BacklogItem[];
}

export const EMPTY_BACKLOG: BacklogData = { version: 1, next: 1, items: [] };

export const BACKLOG_STATUSES: readonly BacklogStatus[] = ['todo', 'doing', 'done'];

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

/** Adds an item at the top of To do (newest ideas start out most visible; drag to reprioritize). */
export function addItem(data: BacklogData, title: string, prefix: string, now: Date): { data: BacklogData; item: BacklogItem } {
  const item: BacklogItem = { id: `${prefix}-${data.next}`, title: title.trim(), status: 'todo', created: now.toISOString() };
  return { data: { ...data, next: data.next + 1, items: [item, ...data.items] }, item };
}

export function updateItem(data: BacklogData, id: string, change: Partial<Pick<BacklogItem, 'title' | 'notes' | 'status' | 'branches'>>): BacklogData {
  return { ...data, items: data.items.map((i) => (i.id === id ? { ...i, ...change } : i)) };
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
export function branchMatches(item: Pick<BacklogItem, 'id' | 'branches' | 'branch'>, branch: string): boolean {
  if (itemBranches(item).includes(branch)) return true;
  const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![0-9])`, 'i').test(branch);
}
