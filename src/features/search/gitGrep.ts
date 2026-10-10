import { GitError, runGit } from '../../core/git/gitCli';
import { highlight, matcher, type FileMatches, type SearchOptions, type SearchResult } from './matcher';

export type { FileMatches, LineMatch, SearchOptions, SearchResult } from './matcher';
export { highlight, matcher } from './matcher';

/** Parses `git grep -n -z` output: "path\0line\0text\n" per match. */
export function parseGrep(out: string, re: RegExp, limit: number): SearchResult {
  const byPath = new Map<string, FileMatches>();
  let count = 0;
  let truncated = false;
  for (const record of out.split('\n')) {
    if (!record) continue;
    const first = record.indexOf('\0');
    const second = record.indexOf('\0', first + 1);
    if (first < 0 || second < 0) continue;
    if (count >= limit) {
      truncated = true;
      break;
    }
    const path = record.slice(0, first);
    const line = Number(record.slice(first + 1, second));
    let file = byPath.get(path);
    if (!file) byPath.set(path, (file = { path, matches: [] }));
    file.matches.push({ line, ...highlight(record.slice(second + 1).replace(/\r$/, ''), re) });
    count++;
  }
  return { files: [...byPath.values()], truncated };
}

/**
 * Searches the tracked and untracked (not ignored) text files of one worktree. A worktree inside another one
 * (`.worktrees/`) is ignored there, so the main worktree's results never include other worktrees' files.
 */
export async function searchWorktree(dir: string, query: string, opts: SearchOptions, limit = 2000): Promise<SearchResult> {
  const re = matcher(query, opts);
  if (!query || !re) return { files: [], truncated: false };
  const args = ['grep', '-n', '-z', '-I', '--untracked', '--no-color'];
  if (!opts.matchCase) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  args.push(opts.regex ? '-E' : '-F', '-e', query);
  let out: string;
  try {
    out = await runGit(args, { cwd: dir, timeoutMs: 60_000 });
  } catch (error) {
    // Exit code 1: nothing found.
    if (error instanceof GitError && error.exitCode === 1) return { files: [], truncated: false };
    throw error;
  }
  return parseGrep(out, re, limit);
}
