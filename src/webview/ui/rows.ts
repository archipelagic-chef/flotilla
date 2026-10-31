import type {
  CommitView,
  FileChangeView,
  SearchGroup,
} from '../protocol';
import type {
  FileMatches,
  LineMatch,
} from '../../features/search/matcher';

/**
 * A row of a history: a commit; when it's expanded, its details (message, who and when) and then each file it changed.
 * Every row is drawn on its own, so a commit with thousands of files doesn't draw them all at once.
 */
export type HistoryRow = { key: string; commit: CommitView } & ({ kind: 'commit' } | { kind: 'details' } | { kind: 'file'; change: FileChangeView });

export function historyRows(
  commits: readonly CommitView[],
  expanded: ReadonlySet<string>,
  files: (hash: string) => { files: FileChangeView[] } | undefined,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const commit of commits) {
    rows.push({ key: `commit:${commit.hash}`, commit, kind: 'commit' });
    if (!expanded.has(commit.hash)) continue;
    rows.push({ key: `details:${commit.hash}`, commit, kind: 'details' });
    for (const change of files(commit.hash)?.files ?? []) rows.push({ key: `file:${commit.hash}:${change.path}`, commit, kind: 'file', change });
  }
  return rows;
}

/**
 * The results as rows, top to bottom: a worktree's name (on the All tab), then each file and, unless it's folded, its
 * matching lines. Only the rows in view are drawn.
 */
export type SearchRow =
  | { key: string; kind: 'ws'; group: SearchGroup }
  | { key: string; kind: 'file'; group: SearchGroup; file: FileMatches; id: string; open: boolean; count: number }
  | { key: string; kind: 'hit'; group: SearchGroup; file: FileMatches; match: LineMatch };

export function searchRows(groups: readonly SearchGroup[], collapsed: ReadonlySet<string>, withWorktrees: boolean): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const group of groups) {
    if (withWorktrees) rows.push({ key: `ws:${group.key}`, kind: 'ws', group });
    for (const file of group.files) {
      const id = `${group.key}\n${file.path}`;
      const open = !collapsed.has(id);
      rows.push({ key: `file:${id}`, kind: 'file', group, file, id, open, count: file.matches.reduce((n, m) => n + m.ranges.length, 0) });
      if (open) for (const match of file.matches) rows.push({ key: `hit:${id}\n${match.line}`, kind: 'hit', group, file, match });
    }
  }
  return rows;
}
