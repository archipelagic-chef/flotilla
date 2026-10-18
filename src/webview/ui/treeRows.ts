import type { DirEntry } from '../protocol';

/** One row of the Files tree, in the order it's shown. Keys are unique within a tree. */
export type TreeRow =
  | { key: string; kind: 'entry'; path: string; entry: DirEntry; depth: number; ignored: boolean }
  | { key: string; kind: 'rename'; path: string; entry: DirEntry; depth: number; error?: string }
  | { key: string; kind: 'create'; dir: string; createKind: 'file' | 'folder'; depth: number; error?: string }
  | { key: string; kind: 'loading'; path: string; depth: number }
  | { key: string; kind: 'empty' };

export interface TreeState {
  /** A folder's entries, or undefined until they're read ('' is the top folder). */
  entries(path: string): DirEntry[] | undefined;
  /** Folders that are expanded. */
  open: ReadonlySet<string>;
  /** A new file or folder being named, in dir. */
  create?: { dir: string; kind: 'file' | 'folder'; error?: string };
  /** A name being changed. */
  rename?: { path: string; error?: string };
}

/**
 * The rows of the Files tree: the top folder's entries, and under each open folder its entries in turn. Ignored
 * folders pass their ignored state on to what's in them.
 */
export function treeRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number, inIgnored: boolean) => {
    const entries = state.entries(dir);
    if (!entries) {
      rows.push({ key: `loading:${dir}`, kind: 'loading', path: dir, depth });
      return;
    }
    const create = state.create?.dir === dir ? state.create : undefined;
    if (create) rows.push({ key: `create:${dir}`, kind: 'create', dir, createKind: create.kind, depth, error: create.error });
    if (!entries.length && depth === 0 && !create) rows.push({ key: 'empty', kind: 'empty' });
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (state.rename?.path === path) {
        rows.push({ key: `rename:${path}`, kind: 'rename', path, entry, depth, error: state.rename.error });
        continue;
      }
      const ignored = inIgnored || !!entry.ignored;
      rows.push({ key: `entry:${path}`, kind: 'entry', path, entry, depth, ignored });
      if (entry.dir && state.open.has(path)) walk(path, depth + 1, ignored);
    }
  };
  walk('', 0, false);
  return rows;
}
