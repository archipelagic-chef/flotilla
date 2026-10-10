import { GitError, runGit } from '../../core/git/gitCli';

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface LineMatch {
  /** 1-based line number. */
  line: number;
  /** The line (shortened around the first match for very long lines). */
  text: string;
  /** [start, end) offsets of the matches in text. */
  ranges: Array<[number, number]>;
}

export interface FileMatches {
  path: string;
  matches: LineMatch[];
}

export interface SearchResult {
  files: FileMatches[];
  /** More matches exist than were returned. */
  truncated: boolean;
}

const MAX_LINE = 240;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The JavaScript regex that finds the same matches git grep reports, to highlight them. Undefined for an invalid regex. */
export function matcher(query: string, opts: SearchOptions): RegExp | undefined {
  const source = opts.regex ? query : escapeRegExp(query);
  try {
    return new RegExp(opts.wholeWord ? `\\b(?:${source})\\b` : source, opts.matchCase ? 'g' : 'gi');
  } catch {
    return undefined;
  }
}

/** Finds the match ranges in a line and shortens long lines around the first match. */
export function highlight(text: string, re: RegExp): { text: string; ranges: Array<[number, number]> } {
  const ranges: Array<[number, number]> = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  if (text.length <= MAX_LINE) return { text, ranges };
  const start = Math.max(0, (ranges[0]?.[0] ?? 0) - 40);
  const clipped = `${start > 0 ? '…' : ''}${text.slice(start, start + MAX_LINE)}`;
  const shift = start > 0 ? start - 1 : 0;
  return {
    text: clipped,
    ranges: ranges.map(([a, b]) => [a - shift, b - shift] as [number, number]).filter(([a, b]) => a >= 0 && b <= clipped.length),
  };
}

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
