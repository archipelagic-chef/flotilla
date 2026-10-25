import { useEffect, useRef, useState } from 'preact/hooks';
import { matcher, replacementFor, type SearchOptions } from '../../features/search/matcher';
import { ALL, type SearchGroup, type WorkstreamView } from '../protocol';
import { send } from './api';
import type { Update } from './app';
import { Virtual } from './virtual';
import { searchRows, type SearchRow } from './rows';
import './search.css';

export interface SearchState {
  query: string;
  options: SearchOptions;
  /** The replace box is open. */
  replacing: boolean;
  replacement: string;
}

export const INITIAL_SEARCH: SearchState = { query: '', options: { matchCase: false, wholeWord: false, regex: false }, replacing: false, replacement: '' };

export interface SearchResults {
  id: number;
  groups: SearchGroup[];
  truncated: boolean;
  limit: number;
  error?: string;
}

interface Props {
  scope: string;
  search: SearchState;
  results: SearchResults | undefined;
  /** Changes after a replace, to search again. */
  refresh: number;
  workstreams: readonly WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  update: Update;
  /** Id of the search that is running; results for older ids are ignored. */
  nextId(): number;
}

const TOGGLES: Array<{ key: keyof SearchOptions; icon: string; label: string }> = [
  { key: 'matchCase', icon: 'case-sensitive', label: 'Match Case' },
  { key: 'wholeWord', icon: 'whole-word', label: 'Match Whole Word' },
  { key: 'regex', icon: 'regex', label: 'Use Regular Expression' },
];

/** A line with its matches highlighted; with a replacement, each match shows as removed text followed by the new text. */
function Highlighted({ text, ranges, replace }: { text: string; ranges: Array<[number, number]>; replace?: (match: string) => string }) {
  const parts = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a));
    const match = text.slice(a, b);
    if (replace) {
      parts.push(<del>{match}</del>);
      parts.push(<ins>{replace(match)}</ins>);
    } else {
      parts.push(<mark>{match}</mark>);
    }
    at = b;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function SearchView({ scope, search, results, refresh, workstreams, colors, update, nextId }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const { query, options, replacing, replacement } = search;

  // A new query starts with the default number of results again.
  useEffect(() => setLimit(undefined), [query, scope]);
  // Search as you type (debounced), and again when the scope, an option or the limit changes, or after a replace.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) send({ type: 'search', id: nextId(), scope, query, options, limit });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, scope, options.matchCase, options.wholeWord, options.regex, limit, refresh]);
  useEffect(() => input.current?.focus(), []);

  const set = (change: Partial<SearchState>) => update((p) => ({ ...p, search: { ...p.search, ...change } }));
  const label = (key: string) => workstreams.find((w) => w.key === key)?.branch ?? key;
  const fileCount = results?.groups.reduce((n, g) => n + g.files.length, 0) ?? 0;
  const matchCount = results?.groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.matches.reduce((k, x) => k + x.ranges.length, 0), 0), 0) ?? 0;
  const toggle = (id: string) => setCollapsed((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set([...c, id])));
  const re = matcher(query, options);
  const preview = replacing && re ? (match: string) => replacementFor(match, re, replacement, options) : undefined;
  const replace = (key?: string, path?: string) => send({ type: 'replace', scope, query, options, replacement, key, path });

  return (
    <div class="search">
      <div class="search-box">
        <div class="search-rows">
          <button
            class="replace-toggle"
            aria-label={replacing ? 'Hide Replace' : 'Show Replace'}
            aria-expanded={replacing}
            onClick={() => set({ replacing: !replacing })}
          >
            <i class={`codicon codicon-chevron-${replacing ? 'down' : 'right'}`} />
          </button>
          <div class="search-fields">
            <div class="search-input">
              <input
                ref={input}
                id="flotilla-search"
                value={query}
                placeholder={scope === ALL ? 'Search all worktrees' : `Search ${label(scope)}`}
                aria-label="Search"
                onInput={(e) => set({ query: (e.target as HTMLInputElement).value })}
              />
              {TOGGLES.map((t) => (
                <button
                  key={t.key}
                  class={`toggle${options[t.key] ? ' on' : ''}`}
                  aria-label={t.label}
                  aria-pressed={options[t.key]}
                  onClick={() => set({ options: { ...options, [t.key]: !options[t.key] } })}
                >
                  <i class={`codicon codicon-${t.icon}`} />
                </button>
              ))}
            </div>
            {replacing && (
              <div class="search-input">
                <input
                  id="flotilla-replace"
                  value={replacement}
                  placeholder={options.regex ? 'Replace ($1 for groups)' : 'Replace'}
                  aria-label="Replace"
                  onInput={(e) => set({ replacement: (e.target as HTMLInputElement).value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && matchCount) replace();
                  }}
                />
                <button class="toggle" aria-label="Replace All" data-keys="Ctrl+Enter" disabled={!matchCount} onClick={() => replace()}>
                  <i class="codicon codicon-replace-all" />
                </button>
              </div>
            )}
          </div>
        </div>
        {query.trim() && results && (
          <div class="search-summary">
            {results.error
              ? results.error
              : matchCount
                ? `${matchCount}${results.truncated ? '+' : ''} result${matchCount === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
                : 'No results found.'}
            {results.truncated && (
              <>
                {' · '}
                <button class="link" onClick={() => setLimit(results.limit * 5)}>
                  Show more
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {query.trim() && results && (
        <Virtual<SearchRow>
          items={searchRows(results.groups, collapsed, scope === ALL)}
          keyOf={(row) => row.key}
          render={(row) => {
            if (row.kind === 'ws')
              return (
                <div class="row search-ws" style={{ '--ws-color': colors.get(row.group.key) }}>
                  <span class="swatch" />
                  <span class="name">{label(row.group.key)}</span>
                </div>
              );
            if (row.kind === 'file') {
              const { group: g, file: f, id, open, count } = row;
              const slash = f.path.lastIndexOf('/');
              return (
                <div
                  class="row"
                  style={{ paddingLeft: '8px' }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggle(id)}
                  onKeyDown={(e) => e.key === 'Enter' && toggle(id)}
                >
                  <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} chev`} />
                  <i class="codicon codicon-file" />
                  <span class="name">{f.path.slice(slash + 1)}</span>
                  <span class="dir">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
                  {replacing && (
                    <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
                      <button class="icon" aria-label="Replace in This File" onClick={() => replace(g.key, f.path)}>
                        <i class="codicon codicon-replace" />
                      </button>
                    </span>
                  )}
                  <span class="badge">{count}</span>
                </div>
              );
            }
            const { group: g, file: f, match: m } = row;
            const indent = m.text.length - m.text.trimStart().length;
            return (
              <button
                class="row hit"
                onClick={() => send({ type: 'openFile', key: g.key, path: f.path, preview: true, line: m.line, range: m.ranges[0] })}
                onDblClick={() => send({ type: 'openFile', key: g.key, path: f.path, preview: false, line: m.line, range: m.ranges[0] })}
              >
                <span class="line-text">
                  <Highlighted text={m.text.trimStart()} ranges={m.ranges.map(([a, b]) => [a - indent, b - indent])} replace={preview} />
                </span>
              </button>
            );
          }}
        />
      )}
    </div>
  );
}
