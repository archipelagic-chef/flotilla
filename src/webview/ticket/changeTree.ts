import type {
  ChangedFile,
  DiffLine,
  FileDiff,
  TicketChange,
} from '../ticketProtocol';

/** A folder of the Changes tree: its name (a chain of folders with nothing else in them, as one: "src/core/git"). */
interface Folder {
  name: string;
  /** Its path from the root, the key it folds by. */
  path: string;
  folders: Folder[];
  files: ChangedFile[];
  count: number;
  added: number;
  deleted: number;
}

/** A row of the Changes section, in the order shown. */
export type ChangeRow =
  | { kind: 'group'; key: string; group: number; open: boolean }
  | { kind: 'folder'; key: string; group: number; depth: number; name: string; count: number; added: number; deleted: number; open: boolean }
  | { kind: 'file'; key: string; group: number; depth: number; name: string; file: ChangedFile };

function folderOf(files: readonly ChangedFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [], count: 0, added: 0, deleted: 0 };
  const byPath = new Map<string, Folder>([['', root]]);
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    const chain = [root];
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let next = byPath.get(p);
      if (!next) {
        next = { name: parts[i], path: p, folders: [], files: [], count: 0, added: 0, deleted: 0 };
        byPath.set(p, next);
        at.folders.push(next);
      }
      at = next;
      chain.push(at);
    }
    at.files.push(f);
    for (const c of chain) {
      c.count++;
      c.added += f.added;
      c.deleted += f.deleted;
    }
  }
  return root;
}

/** A folder whose only content is one folder takes it into its name. */
function compact(f: Folder): Folder {
  let at = f;
  while (at.files.length === 0 && at.folders.length === 1 && at.path !== '') {
    const only = at.folders[0];
    at = { ...only, name: `${at.name}/${only.name}` };
  }
  return { ...at, folders: at.folders.map(compact) };
}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The rows of the Changes tree: per group (a branch, the merge) its header, then its folders and files, folders first.
 * A folded group or folder (its key in folded) shows its row, not what's in it. With one group, its header is left out.
 */
export function changeRows(change: TicketChange, folded: ReadonlySet<string>): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const headers = change.groups.filter((g) => g.files.length).length > 1;
  change.groups.forEach((g, group) => {
    // A branch the path filter leaves nothing of (BL-174).
    if (!g.files.length) return;
    const key = `${group}:`;
    const open = !folded.has(key);
    if (headers) rows.push({ kind: 'group', key, group, open });
    if (!open && headers) return;
    const walk = (f: Folder, depth: number) => {
      for (const sub of [...f.folders].sort(byName)) {
        const k = `${group}:${sub.path}/`;
        const subOpen = !folded.has(k);
        rows.push({ kind: 'folder', key: k, group, depth, name: sub.name, count: sub.count, added: sub.added, deleted: sub.deleted, open: subOpen });
        if (subOpen) walk(sub, depth + 1);
      }
      for (const file of f.files.map((x) => ({ name: x.path.split('/').pop() ?? x.path, file: x })).sort(byName)) {
        rows.push({ kind: 'file', key: `${group}:${file.file.path}`, group, depth, name: file.name, file: file.file });
      }
    };
    walk(compact(folderOf(g.files)), headers ? 1 : 0);
  });
  return rows;
}

/** A row of a file's diff, unfolded inline under it: a hunk's head (opens the diff beside at it), a line, a note. */
export type DiffRow =
  | { kind: 'hunk'; key: string; group: number; path: string; depth: number; line: number; label: string }
  | { kind: 'line'; key: string; depth: number; line: DiffLine }
  | { kind: 'note'; key: string; group: number; path: string; depth: number; text: string }
  | { kind: 'more'; key: string; hunk: string; depth: number; count: number };

/** A hunk inline shows this many of its lines; the rest fold into one row ("40 more lines") until it's opened. */
export const HUNK_LINES = 12;

/**
 * The rows with the diffs of the unfolded files (by their row's key) under them: each hunk's head, then its lines, past
 * HUNK_LINES folded into a "more" row unless the hunk (its head's key) is in opened (BL-172). A diff not read yet (none
 * in diffs) shows as "Reading its diff…".
 */
export function withDiffs(
  rows: readonly ChangeRow[],
  unfolded: ReadonlySet<string>,
  diffs: ReadonlyMap<string, FileDiff>,
  opened: ReadonlySet<string> = new Set(),
): Array<ChangeRow | DiffRow> {
  const out: Array<ChangeRow | DiffRow> = [];
  for (const r of rows) {
    out.push(r);
    if (r.kind !== 'file' || !unfolded.has(r.key)) continue;
    const { group } = r;
    const { path } = r.file;
    const depth = r.depth + 1;
    const diff = diffs.get(r.key);
    if (!diff || 'note' in diff) {
      out.push({ kind: 'note', key: `${r.key}#note`, group, path, depth, text: diff ? diff.note : 'Reading its diff…' });
      continue;
    }
    diff.hunks.forEach((h, i) => {
      const old = h.lines.filter((l) => l.kind !== 'added').length;
      const next = h.lines.filter((l) => l.kind !== 'deleted').length;
      const label = `@@ −${h.oldStart},${old} +${h.newStart},${next} @@`;
      const hunk = `${r.key}#${i}`;
      out.push({ kind: 'hunk', key: hunk, group, path, depth, line: Math.max(1, h.newStart), label });
      // One more line than the fold would hide shows, rather than a row saying "1 more line".
      const shown = opened.has(hunk) || h.lines.length <= HUNK_LINES + 1 ? h.lines.length : HUNK_LINES;
      h.lines.slice(0, shown).forEach((line, j) => out.push({ kind: 'line', key: `${hunk}:${j}`, depth, line }));
      if (shown < h.lines.length) out.push({ kind: 'more', key: `${hunk}:more`, hunk, depth, count: h.lines.length - shown });
    });
  }
  return out;
}

/** A row of a file's full view: a line, or a stretch of unchanged lines folded (its first line's index in lines). */
export type FullRow = { kind: 'line'; key: string; line: DiffLine } | { kind: 'gap'; key: string; index: number; count: number };

/**
 * The rows of a file's full view (BL-171): all its lines, where unchanged stretches further than `context` lines from
 * a change fold into one row ("42 unchanged lines"), unless their first line's index is in shown. A stretch too short
 * to be worth folding shows.
 */
export function fullRows(lines: readonly DiffLine[], shown: ReadonlySet<number>, context = 3): FullRow[] {
  const n = lines.length;
  // Distance to the nearest change, before and after.
  const near = new Array<boolean>(n).fill(false);
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lines[i].kind !== 'context') last = i;
    near[i] = i - last <= context;
  }
  last = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].kind !== 'context') last = i;
    if (last - i <= context) near[i] = true;
  }
  const rows: FullRow[] = [];
  const line = (i: number) => rows.push({ kind: 'line', key: `l${i}`, line: lines[i] });
  for (let i = 0; i < n;) {
    if (near[i]) {
      line(i++);
      continue;
    }
    let j = i;
    while (j < n && !near[j]) j++;
    if (j - i <= 3 || shown.has(i)) for (let k = i; k < j; k++) line(k);
    else rows.push({ kind: 'gap', key: `g${i}`, index: i, count: j - i });
    i = j;
  }
  return rows;
}

/**
 * The files a path filter leaves (BL-174): those whose path has each of its words (case aside); a word with "*" is a
 * glob ("*" any characters but "/", "**" any). An empty filter leaves them all.
 */
export function filterFiles<F extends Pick<ChangedFile, 'path' | 'origPath'>>(files: readonly F[], filter: string): F[] {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...files];
  const tests = words.map((w) => {
    if (!w.includes('*')) return (p: string) => p.includes(w);
    const re = new RegExp(
      w
        .split(/(\*\*|\*)/)
        .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
        .join(''),
    );
    return (p: string) => re.test(p);
  });
  return files.filter((f) => {
    const paths = [f.path, ...(f.origPath ? [f.origPath] : [])].map((p) => p.toLowerCase());
    return tests.every((t) => paths.some(t));
  });
}

/** The change with only the files a path filter leaves, its counts theirs; its groups stay where they were (by index). */
export function filterChange(change: TicketChange, filter: string): TicketChange {
  if (!filter.trim()) return change;
  const groups = change.groups.map((g) => {
    const files = filterFiles(g.files, filter);
    return {
      ...g,
      files,
      added: files.reduce((n, f) => n + f.added, 0),
      deleted: files.reduce((n, f) => n + f.deleted, 0),
      uncommitted: files.filter((f) => f.uncommitted).length,
    };
  });
  return {
    ...change,
    groups,
    files: groups.reduce((n, g) => n + g.files.length, 0),
    added: groups.reduce((n, g) => n + g.added, 0),
    deleted: groups.reduce((n, g) => n + g.deleted, 0),
  };
}

/**
 * "Since my last review" (BL-174): the ticket's commits made after the user's last entry in its activity (a comment, a
 * review's verdict), newest first as given; none when they've written nothing yet. Entries' dates are local
 * ("YYYY-MM-DD HH:MM"), commits' ISO 8601.
 */
export function sinceLastReview(commits: ReadonlyArray<{ hash: string; date: string }>, activity: ReadonlyArray<{ author?: string; date?: string }>): string[] {
  const own = activity.filter((e) => e.author === 'You' && e.date).map((e) => new Date(e.date!.replace(' ', 'T')).getTime());
  const last = Math.max(...own.filter(Number.isFinite));
  if (!Number.isFinite(last)) return [];
  // Within the minute of the entry counts as before it: the entry's time has no seconds.
  return commits.filter((c) => new Date(c.date).getTime() >= last + 60_000).map((c) => c.hash);
}

/**
 * The changed file a link points at (BL-174): a path from the repository's root (as reports link them, "src/x.ts#L42",
 * "src/x.ts:42", "./src/x.ts"), with the group it's in (the first that has it) and the line, if any. Web links, anchors
 * and other files: none.
 */
export function changeLink(href: string, change: TicketChange | undefined): { group: number; path: string; line?: number } | undefined {
  if (!change || !href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  let rest = href;
  let line: number | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const m = /^L(\d+)/i.exec(rest.slice(hash + 1));
    if (m) line = Number(m[1]);
    rest = rest.slice(0, hash);
  } else {
    const m = /^(.*?):(\d+)(?:[:-]\d+)?$/.exec(rest);
    if (m) {
      rest = m[1];
      line = Number(m[2]);
    }
  }
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // As written.
  }
  const path = rest.replace(/^\.\//, '').replace(/^\/+/, '');
  const group = change.groups.findIndex((g) => g.files.some((f) => f.path === path));
  if (group < 0) return undefined;
  return { group, path, ...(line ? { line } : {}) };
}

/** The letter of a file's change, as Source Control shows it. */
export function changeLetter(f: Pick<ChangedFile, 'kind'>): string {
  switch (f.kind) {
    case 'added':
    case 'untracked':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'conflicted':
      return '!';
    default:
      return 'M';
  }
}

/** The rows to render of a long list: those in view (with some either side), and the space above them. */
export function rowWindow(total: number, scrollTop: number, viewHeight: number, rowHeight: number, extra = 10): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - extra);
  const end = Math.min(total, Math.ceil((scrollTop + viewHeight) / rowHeight) + extra);
  return { start, end };
}
