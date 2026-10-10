import { useEffect, useRef, useState } from 'preact/hooks';
import type { SearchOptions } from '../../features/search/gitGrep';
import { ALL, type SearchGroup, type WorkstreamView } from '../protocol';
import { send } from './api';
import type { Update } from './app';

export interface SearchState {
  query: string;
  options: SearchOptions;
}

export const INITIAL_SEARCH: SearchState = { query: '', options: { matchCase: false, wholeWord: false, regex: false } };

export interface SearchResults {
  id: number;
  groups: SearchGroup[];
  truncated: boolean;
  error?: string;
}

interface Props {
  scope: string;
  search: SearchState;
  results: SearchResults | undefined;
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

function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const parts = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark>{text.slice(a, b)}</mark>);
    at = b;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function SearchView({ scope, search, results, workstreams, colors, update, nextId }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { query, options } = search;

  // Search as you type (debounced), and again when the scope or an option changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) send({ type: 'search', id: nextId(), scope, query, options });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, scope, options.matchCase, options.wholeWord, options.regex]);
  useEffect(() => input.current?.focus(), []);

  const set = (change: Partial<SearchState>) => update((p) => ({ ...p, search: { ...p.search, ...change } }));
  const label = (key: string) => workstreams.find((w) => w.key === key)?.branch ?? key;
  const fileCount = results?.groups.reduce((n, g) => n + g.files.length, 0) ?? 0;
  const matchCount = results?.groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.matches.length, 0), 0) ?? 0;
  const toggle = (id: string) => setCollapsed((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set([...c, id])));

  return (
    <div class="search">
      <div class="search-box">
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
              title={t.label}
              aria-pressed={options[t.key]}
              onClick={() => set({ options: { ...options, [t.key]: !options[t.key] } })}
            >
              <i class={`codicon codicon-${t.icon}`} />
            </button>
          ))}
        </div>
        {query.trim() && results && (
          <div class="search-summary">
            {results.error
              ? results.error
              : matchCount
                ? `${matchCount}${results.truncated ? '+' : ''} result${matchCount === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}${results.truncated ? ' (showing the first ones; refine the search)' : ''}`
                : 'No results found.'}
          </div>
        )}
      </div>
      {query.trim() &&
        results?.groups.map((g) => (
          <div key={g.key} class="search-group">
            {scope === ALL && (
              <div class="row search-ws" style={{ '--ws-color': colors.get(g.key) }}>
                <span class="swatch" />
                <span class="name">{label(g.key)}</span>
              </div>
            )}
            {g.files.map((f) => {
              const id = `${g.key}\n${f.path}`;
              const open = !collapsed.has(id);
              const slash = f.path.lastIndexOf('/');
              return (
                <div key={id}>
                  <button class="row" style={{ paddingLeft: '8px' }} aria-expanded={open} onClick={() => toggle(id)}>
                    <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} chev`} />
                    <i class="codicon codicon-file" />
                    <span class="name">{f.path.slice(slash + 1)}</span>
                    <span class="dir">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
                    <span class="badge">{f.matches.length}</span>
                  </button>
                  {open &&
                    f.matches.map((m) => (
                      <button
                        key={m.line}
                        class="row hit"
                        title={`${f.path}:${m.line}`}
                        onClick={() => send({ type: 'openFile', key: g.key, path: f.path, preview: true, line: m.line, range: m.ranges[0] })}
                        onDblClick={() => send({ type: 'openFile', key: g.key, path: f.path, preview: false, line: m.line, range: m.ranges[0] })}
                      >
                        <span class="line-text">
                          <Highlighted text={m.text.trimStart()} ranges={m.ranges.map(([a, b]) => [a - (m.text.length - m.text.trimStart().length), b - (m.text.length - m.text.trimStart().length)])} />
                        </span>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
