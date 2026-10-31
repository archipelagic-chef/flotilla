import type {
  ChangeKind,
  FileChange,
} from '../../core/git/porcelain';

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * The change marks of the entries in the listed folders, by path, from a worktree's whole change lists: a file's own
 * change; a folder's own (an untracked folder) or else that of a change inside it, new files showing as a modified
 * folder. Unstaged wins over staged (it is what's on disk). Only the entries of listed folders are marked, so the
 * result stays as small as what the Files tab shows, however many changes there are.
 */
export function changeMarks(staged: readonly FileChange[], unstaged: readonly FileChange[], folders: ReadonlySet<string>): Record<string, ChangeKind> {
  const changes = new Map<string, ChangeKind>();
  // Untracked folders come as "dir/".
  for (const c of [...staged, ...unstaged]) changes.set(c.path.replace(/\/$/, ''), c.kind);
  const marks: Record<string, ChangeKind> = {};
  for (const [p, kind] of changes) if (folders.has(parentOf(p))) marks[p] = kind;
  for (const [p, kind] of changes) {
    const inner = kind === 'untracked' || kind === 'added' ? 'modified' : kind;
    for (let dir = parentOf(p); dir !== ''; dir = parentOf(dir)) {
      if (folders.has(parentOf(dir))) marks[dir] ??= inner;
    }
  }
  return marks;
}

/** The folders each worktree's Files tab has listed, and the marks last sent for them. */
export class ListedFolders {
  private readonly folders = new Map<string, Set<string>>();
  private readonly sent = new Map<string, string>();

  add(key: string, rel: string): void {
    const set = this.folders.get(key) ?? new Set<string>();
    set.add(rel);
    this.folders.set(key, set);
  }

  of(key: string): ReadonlySet<string> {
    return this.folders.get(key) ?? new Set();
  }

  /** Forgets the worktrees that aren't in keys any more. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.folders.keys()]) if (!keys.has(key)) this.folders.delete(key);
    for (const key of [...this.sent.keys()]) if (!keys.has(key)) this.sent.delete(key);
  }

  /** Whether marks differ from the ones last sent for key; they count as sent from now on. */
  changed(key: string, marks: Record<string, ChangeKind>): boolean {
    const json = JSON.stringify(marks);
    if (this.sent.get(key) === json) return false;
    this.sent.set(key, json);
    return true;
  }

  /** The page was loaded again: it has listed nothing, and holds no marks. */
  clear(): void {
    this.folders.clear();
    this.sent.clear();
  }
}
