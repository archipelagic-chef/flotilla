import type { ChangedFile, TicketChange } from '../ticketProtocol';

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
