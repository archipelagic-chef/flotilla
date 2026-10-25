import type { ChangedFile, DiffLine, FileDiff, TicketChange } from '../ticketProtocol';

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
  const headers = change.groups.length > 1;
  change.groups.forEach((g, group) => {
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
  | { kind: 'note'; key: string; group: number; path: string; depth: number; text: string };

/**
 * The rows with the diffs of the unfolded files (by their row's key) under them: each hunk's head, then its lines. A
 * diff not read yet (none in diffs) shows as "Reading its diff…".
 */
export function withDiffs(rows: readonly ChangeRow[], unfolded: ReadonlySet<string>, diffs: ReadonlyMap<string, FileDiff>): Array<ChangeRow | DiffRow> {
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
      out.push({ kind: 'hunk', key: `${r.key}#${i}`, group, path, depth, line: Math.max(1, h.newStart), label });
      h.lines.forEach((line, j) => out.push({ kind: 'line', key: `${r.key}#${i}:${j}`, depth, line }));
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
  for (let i = 0; i < n; ) {
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
