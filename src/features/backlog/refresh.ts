/**
 * Which open tickets a change refreshes. Pure: the ticket panels gather what they know (files, records, worktrees,
 * refs) and this decides, so the choice can be tested without VS Code or git.
 */

/** A ticket open in a panel, as far as the choice needs it. */
export interface OpenTicket {
  id: string;
  /** Its item's id and its linked issues' ids: what its commits mention. */
  ids: readonly string[];
  /** The worktree keys and the agent keys its view shows: a change to one of them changes the view. */
  keys: ReadonlySet<string>;
  /** Whether a branch is the item's (a moved branch moves its commits). */
  branches(branch: string): boolean;
}

/** A matcher for "mentions one of these ids": whole ids only, case-insensitive ("BL-1" isn't in "BL-12"). */
export function idMatcher(ids: readonly string[]): (text: string) => boolean {
  const whole = ids.map((id) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i'));
  return (text) => whole.some((r) => r.test(text));
}

/**
 * The tickets a backlog-folder change refreshes: a ticket whose file changed; an item whose record in backlog.json
 * changed (with its parent and its parts, whose lists show it). '*' (a change without a name) and posted.json (not
 * known per ticket) refresh them all.
 */
export function ticketsForBacklogChange(input: {
  items: ReadonlyArray<{ id: string; parent?: string }>;
  /** The items whose records changed. */
  changed: ReadonlySet<string>;
  /** The names of the backlog folder's files that changed. */
  files: ReadonlySet<string>;
}): ReadonlySet<string> | 'all' {
  if (input.files.has('*') || input.files.has('posted.json')) return 'all';
  const ids = new Set(input.changed);
  for (const id of input.changed) {
    const item = input.items.find((i) => i.id === id);
    if (item?.parent) ids.add(item.parent);
    for (const c of input.items) if (c.parent === id) ids.add(c.id);
  }
  for (const f of input.files) {
    const m = /^(.+)\.md$/.exec(f);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** What moved in the repository's refs, since the mention index was read. */
export interface RefMoves {
  /** Local branches whose tips moved (or appeared, or went). */
  branches: readonly string[];
  /** Commits that came in. */
  commits: ReadonlyArray<{ subject: string; body: string }>;
}

/**
 * The tickets a repository change refreshes: one whose worktrees or agents changed (keys); one a changed chat was
 * started for; and, when refs moved, one whose branch moved or whose ids a new commit mentions. Other tickets keep
 * their view.
 */
export function ticketsForRepositoryChange(input: {
  open: readonly OpenTicket[];
  /** The worktrees whose state changed (or appeared, or went). */
  changedKeys: ReadonlySet<string>;
  /** The items that changed chats were started for. */
  chatStarts: readonly string[];
  moves?: RefMoves;
}): Set<string> {
  const out = new Set<string>();
  for (const t of input.open) {
    if ([...t.keys].some((k) => input.changedKeys.has(k)) || input.chatStarts.includes(t.id)) {
      out.add(t.id);
      continue;
    }
    const moves = input.moves;
    if (!moves) continue;
    const mentioned = idMatcher(t.ids);
    if (moves.branches.some((b) => t.branches(b)) || moves.commits.some((c) => mentioned(`${c.subject}\n${c.body}`))) out.add(t.id);
  }
  return out;
}
