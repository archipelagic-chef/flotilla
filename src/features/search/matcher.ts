/** Search matching shared by the extension (git grep results, replace) and the webview (highlights, replace preview). No Node or VS Code APIs. */

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

/** The text a match is replaced with: regex replacements may use $1, $& etc.; literal ones are inserted as typed. */
export function replacementFor(match: string, re: RegExp, replacement: string, opts: SearchOptions): string {
  if (!opts.regex) return replacement;
  const single = new RegExp(re.source, re.flags.replace('g', ''));
  return match.replace(single, replacement);
}

/** Replaces every match in text; returns the new text and the number of replacements. */
export function replaceAll(text: string, query: string, replacement: string, opts: SearchOptions): { text: string; count: number } {
  const re = matcher(query, opts);
  if (!re || !query) return { text, count: 0 };
  let count = 0;
  const out = text.replace(re, (m) => {
    if (m === '') return m;
    count++;
    return replacementFor(m, re, replacement, opts);
  });
  return { text: out, count };
}
