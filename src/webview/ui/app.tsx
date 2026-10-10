import { Fragment } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ALL, type CompareMode, type DirEntry, type HostMessage, type Tool, type VcView, type WorkstreamView } from '../protocol';
import { menuContext, run, send, vscode } from './api';
import { ChatsBody, HooksNotice } from './chats';
import { FilesBody, type Editing } from './files';
import { Hover, WorktreeCard } from './hover';
import { setIconTheme } from './icons';
import { Overview } from './overview';
import { INITIAL_SEARCH, SearchView, type SearchResults, type SearchState } from './search';
import { Section, WorktreeHeader } from './section';
import { CommitCard, CompareBody, HistoryBody, VcBody, type CommitFiles, type Comparison, type Log, type Refs } from './vc';

/** UI state that survives reloads of the webview (VS Code keeps it per view). */
export interface Persisted {
  tool: Tool;
  /** Collapsed sections of the All tab (workstream keys). */
  collapsed: string[];
  /** Expanded folders per workstream key. */
  expanded: Record<string, string[]>;
  /** Commit message drafts per workstream key. */
  drafts: Record<string, string>;
  /** Workstream keys whose chat history is open. */
  history: string[];
  /** The view under Version Control. */
  vcView: VcView;
  /** What each worktree is compared with in Version Control › Compare. */
  compare: Record<string, { base?: string; mode: CompareMode }>;
  search: SearchState;
}

const INITIAL: Persisted = { tool: 'files', collapsed: [], expanded: {}, drafts: {}, history: [], vcView: 'changes', compare: {}, search: INITIAL_SEARCH };

export type Update = (change: (p: Persisted) => Persisted) => void;

export interface Highlight {
  key: string;
  path: string;
}

/** Selected rows of one worktree's tree; anchor is where a Shift range starts. */
export interface Selection {
  key: string;
  paths: string[];
  anchor: string;
}

export interface FilesApi {
  dirs: ReadonlyMap<string, DirEntry[]>;
  requestDir(key: string, path: string): void;
  selection: Selection | undefined;
  isSelected(key: string, path: string): boolean;
  /** single: just this row; toggle: add or remove it (Ctrl/Cmd); range: from the anchor to it (Shift). */
  select(key: string, path: string, mode: 'single' | 'toggle' | 'range'): void;
  editing: Editing | undefined;
  stopEditing(): void;
}

export const dirKey = (key: string, path: string) => `${key}\n${path}`;

/** Under Version Control in the tool strip, shown while it's the tool. */
const VC_VIEWS: Array<{ id: VcView; label: string; icon: string }> = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'compare', label: 'Compare', icon: 'git-compare' },
];

const TOOLS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'vc', label: 'Version Control', icon: 'source-control' },
  { id: 'chats', label: 'Chats', icon: 'comment-discussion' },
];

/** Worktree colors, from the theme's terminal palette so they suit every theme. */
const COLORS = ['Blue', 'Green', 'Magenta', 'Yellow', 'Cyan', 'Red', 'BrightBlue', 'BrightMagenta'];

/** A color per worktree, distinct for up to eight of them and stable while the set of worktrees stays the same. */
function colorsFor(workstreams: readonly WorkstreamView[]): Map<string, string> {
  const keys = workstreams.map((w) => w.key).sort();
  return new Map(keys.map((k, i) => [k, `var(--vscode-terminal-ansi${COLORS[i % COLORS.length]})`]));
}

const ATTENTION_DOT: Record<string, string | undefined> = {
  'waiting-for-input': 'waiting',
  error: 'error',
  working: 'working',
  done: 'done',
};

function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function App() {
  const [persisted, setPersisted] = useState<Persisted>(() => {
    const saved = (vscode.getState() as Partial<Persisted> | undefined) ?? {};
    return { ...INITIAL, ...saved, search: { ...INITIAL_SEARCH, ...saved.search } };
  });
  const [workstreams, setWorkstreams] = useState<WorkstreamView[] | undefined>(undefined);
  const [active, setActiveState] = useState<string>(ALL);
  /** Worktrees whose tab is closed; they stay in the Overview. */
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [dirs, setDirs] = useState<Map<string, DirEntry[]>>(new Map());
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [results, setResults] = useState<SearchResults | undefined>(undefined);
  const [searchRefresh, setSearchRefresh] = useState(0);
  const [logs, setLogs] = useState<ReadonlyMap<string, Log>>(new Map());
  const [refs, setRefs] = useState<ReadonlyMap<string, Refs>>(new Map());
  /** Files of expanded commits, by worktree key and hash. */
  const [commitFiles, setCommitFiles] = useState<ReadonlyMap<string, CommitFiles>>(new Map());
  const [comparisons, setComparisons] = useState<ReadonlyMap<string, Comparison>>(new Map());
  const tabStrip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const searchId = useRef(0);
  const requested = useRef(new Set<string>());
  const pendingScroll = useRef<{ key: string; path?: string; until: number } | undefined>(undefined);
  const stateRef = useRef({ persisted, active });
  stateRef.current = { persisted, active };

  const update: Update = useCallback((change) => {
    setPersisted((prev) => {
      const next = change(prev);
      vscode.setState(next);
      return next;
    });
  }, []);

  /** Makes a worktree (or ALL) active here and in the extension (status bar, new terminals and chats). */
  const setActive = useCallback((key: string) => {
    setActiveState(key);
    send({ type: 'active', key });
  }, []);

  const requestDir = useCallback((key: string, path: string) => {
    const k = dirKey(key, path);
    if (requested.current.has(k)) return;
    requested.current.add(k);
    send({ type: 'listDir', key, path });
  }, []);

  /** Reads a page of a worktree's history; the list shown stays until it arrives. */
  const requestLog = useCallback((key: string, skip: number) => {
    setLogs((prev) => new Map(prev).set(key, { ...(prev.get(key) ?? { commits: [], more: false }), loading: true }));
    send({ type: 'log', key, skip });
  }, []);

  const requestCommitFiles = useCallback((key: string, hash: string) => {
    setCommitFiles((prev) => (prev.has(`${key}\n${hash}`) ? prev : new Map(prev).set(`${key}\n${hash}`, { files: [], loading: true })));
    send({ type: 'commitFiles', key, hash });
  }, []);

  const requestRefs = useCallback((key: string) => {
    setRefs((prev) => new Map(prev).set(key, { refs: [] }));
    send({ type: 'refs', key });
  }, []);

  const compare = useCallback((key: string, base: string, mode: CompareMode) => {
    setComparisons((prev) => {
      const old = prev.get(key);
      const same = old && old.base === base && old.mode === mode;
      return new Map(prev).set(key, { base, mode, files: same ? old.files : [], loading: true });
    });
    send({ type: 'compare', key, base, mode });
  }, []);

  const chooseCompare = useCallback(
    (key: string, choice: { base?: string; mode: CompareMode }) => update((p) => ({ ...p, compare: { ...p.compare, [key]: choice } })),
    [update],
  );

  /** Which way the tab strip can scroll; the arrows beside it are enabled accordingly. */
  const measureTabs = useCallback(() => {
    const el = tabStrip.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
  }, []);
  const scrollTabs = (direction: -1 | 1) => {
    const el = tabStrip.current;
    if (el) el.scrollBy({ left: direction * Math.max(60, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  const onMessage = useCallback(
    (m: HostMessage) => {
      const { persisted: p, active: current } = stateRef.current;
      switch (m.type) {
        case 'state':
          setWorkstreams(m.workstreams);
          return;
        case 'active':
          setActiveState(m.key);
          return;
        case 'tabs':
          setClosed(new Set(m.closed));
          return;
        case 'dir':
          setDirs((prev) => new Map(prev).set(dirKey(m.key, m.path), m.entries));
          return;
        case 'dirsChanged':
          for (const path of m.paths) {
            if (requested.current.delete(dirKey(m.key, path))) requestDir(m.key, path);
          }
          return;
        case 'tool':
          update((prev) => ({ ...prev, tool: m.tool }));
          return;
        case 'searchResults':
          if (m.id === searchId.current) setResults({ id: m.id, groups: m.groups, truncated: m.truncated, limit: m.limit, error: m.error });
          return;
        case 'iconTheme':
          setIconTheme(m.theme);
          setDirs((prev) => new Map(prev)); // re-render with the new icons
          return;
        case 'replaced':
          setSearchRefresh((n) => n + 1);
          return;
        case 'log':
          setLogs((prev) => {
            const old = prev.get(m.key);
            // A later page of a history that has moved on since (a commit, a pull) is dropped; page one follows.
            if (m.skip > 0 && old?.head !== m.head) return prev;
            const commits = m.skip > 0 ? [...(old?.commits ?? []).slice(0, m.skip), ...m.commits] : m.commits;
            return new Map(prev).set(m.key, { head: m.head, commits, more: m.more, loading: false, error: m.error });
          });
          return;
        case 'commitFiles':
          setCommitFiles((prev) => new Map(prev).set(`${m.key}\n${m.hash}`, { files: m.files, error: m.error }));
          return;
        case 'refs':
          setRefs((prev) => new Map(prev).set(m.key, { defaultBase: m.defaultBase, refs: m.refs }));
          return;
        case 'compared':
          setComparisons((prev) => {
            const old = prev.get(m.key);
            // Only the answer to the latest question counts.
            if (old && (old.base !== m.base || old.mode !== m.mode)) return prev;
            return new Map(prev).set(m.key, { base: m.base, mode: m.mode, files: m.files, error: m.error });
          });
          return;
        case 'committed':
          update((prev) => {
            const drafts = { ...prev.drafts };
            delete drafts[m.key];
            return { ...prev, drafts };
          });
          return;
        case 'edit': {
          // Show the folder the new item goes into (or the renamed item's folder), in the Files tool of that worktree.
          const dir = m.kind === 'rename' ? m.path.split('/').slice(0, -1).join('/') : m.dir;
          const parents = dir ? ancestors(`${dir}/x`) : [];
          if (current !== ALL && current !== m.key) setActive(m.key);
          update((prev) => ({
            ...prev,
            tool: 'files',
            collapsed: prev.collapsed.filter((c) => c !== m.key),
            expanded: { ...prev.expanded, [m.key]: [...new Set([...(prev.expanded[m.key] ?? []), ...parents])] },
          }));
          for (const d of ['', ...parents]) requestDir(m.key, d);
          setEditing(m.kind === 'rename' ? { key: m.key, kind: 'rename', path: m.path } : { key: m.key, kind: m.kind, dir: m.dir });
          return;
        }
        case 'editResult':
          setEditing((e) => (m.ok ? undefined : e && { ...e, error: m.error }));
          return;
        case 'reveal': {
          if (m.path === undefined) {
            // A worktree to show (e.g. one just created): make it active.
            setActive(m.key);
            if (m.tool) update((prev) => ({ ...prev, tool: m.tool! }));
            return;
          }
          // The active editor's file, like the Explorer's auto-reveal: only in the Files tool, and only if its worktree is shown.
          if (p.tool !== 'files' || (current !== ALL && current !== m.key)) return;
          const parents = ancestors(m.path);
          update((prev) => ({
            ...prev,
            collapsed: prev.collapsed.filter((c) => c !== m.key),
            expanded: { ...prev.expanded, [m.key]: [...new Set([...(prev.expanded[m.key] ?? []), ...parents])] },
          }));
          for (const d of ['', ...parents]) requestDir(m.key, d);
          setSelection({ key: m.key, paths: [m.path], anchor: m.path });
          pendingScroll.current = { key: m.key, path: m.path, until: Date.now() + 3000 };
          return;
        }
      }
    },
    [requestDir, setActive, update],
  );

  useEffect(() => {
    const listener = (e: MessageEvent<HostMessage>) => onMessage(e.data);
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [onMessage]);

  // Scrolls a revealed file into view once it is rendered (it may need folder listings first).
  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingScroll.current = undefined;
      return;
    }
    const row = document.querySelector<HTMLElement>(`[data-section="${CSS.escape(pending.key)}"] [data-path="${CSS.escape(pending.path ?? '')}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      pendingScroll.current = undefined;
    }
  });

  // Keep the active worktree tab visible when there are more tabs than room.
  useEffect(() => {
    document.querySelector<HTMLElement>('.wt-tab[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, workstreams]);

  useEffect(() => {
    const el = tabStrip.current;
    if (!el) return;
    measureTabs();
    const resized = new ResizeObserver(measureTabs);
    resized.observe(el);
    return () => resized.disconnect();
  }, [workstreams === undefined, measureTabs]);
  useEffect(measureTabs, [workstreams, closed, active, measureTabs]);

  if (!workstreams) return <div class="empty">Loading worktrees…</div>;

  const { tool, vcView } = persisted;
  const colors = colorsFor(workstreams);
  const activeWs = active === ALL ? undefined : workstreams.find((w) => w.key === active);
  const scope = activeWs ? [activeWs] : workstreams;
  const changeCount = scope.reduce((n, w) => n + w.staged.length + w.unstaged.length, 0);
  const waitingCount = scope.reduce((n, w) => n + w.chats.filter((c) => c.open && c.state === 'waiting-for-input').length, 0);
  const files: FilesApi = {
    dirs,
    requestDir,
    selection,
    isSelected: (key, path) => selection?.key === key && selection.paths.includes(path),
    select: (key, path, mode) =>
      setSelection((sel) => {
        if (mode === 'single' || !sel || sel.key !== key) return { key, paths: [path], anchor: path };
        if (mode === 'toggle') {
          const paths = sel.paths.includes(path) ? sel.paths.filter((p) => p !== path) : [...sel.paths, path];
          return { key, paths, anchor: path };
        }
        // A range covers the visible rows between the anchor and this one, in the order they are shown.
        const rows = [...document.querySelectorAll<HTMLElement>(`.content [role="treeitem"][data-key="${CSS.escape(key)}"]`)].map(
          (r) => r.dataset.path!,
        );
        const [a, b] = [rows.indexOf(sel.anchor), rows.indexOf(path)].sort((x, y) => x - y);
        return a < 0 ? { key, paths: [path], anchor: path } : { key, paths: rows.slice(a, b + 1), anchor: sel.anchor };
      }),
    editing,
    stopEditing: () => setEditing(undefined),
  };
  const body = (ws: WorkstreamView) => (
    <>
      {tool === 'files' && <FilesBody ws={ws} files={files} expanded={persisted.expanded[ws.key] ?? []} update={update} />}
      {tool === 'vc' && vcView === 'changes' && <VcBody ws={ws} draft={persisted.drafts[ws.key] ?? ''} update={update} />}
      {tool === 'vc' && vcView === 'history' && (
        <HistoryBody
          ws={ws}
          log={logs.get(ws.key)}
          requestLog={requestLog}
          files={(hash) => commitFiles.get(`${ws.key}\n${hash}`)}
          requestFiles={requestCommitFiles}
        />
      )}
      {tool === 'vc' && vcView === 'compare' && (
        <CompareBody
          ws={ws}
          choice={persisted.compare[ws.key]}
          refs={refs.get(ws.key)}
          comparison={comparisons.get(ws.key)}
          choose={chooseCompare}
          requestRefs={requestRefs}
          compare={compare}
        />
      )}
      {tool === 'chats' && <ChatsBody ws={ws} historyOpen={persisted.history.includes(ws.key)} update={update} />}
    </>
  );

  let content;
  if (tool === 'overview') {
    content = (
      <Overview
        workstreams={workstreams}
        active={active}
        colors={colors}
        closed={closed}
        onSelect={(key) => {
          setClosed((c) => new Set([...c].filter((k) => k !== key)));
          setActive(key);
          update((p) => ({ ...p, tool: 'files' }));
        }}
      />
    );
  } else if (tool === 'search') {
    content = (
      <>
        {activeWs && <WorktreeHeader ws={activeWs} tool={tool} />}
        <SearchView
          scope={activeWs ? activeWs.key : ALL}
          search={persisted.search}
          results={results}
          refresh={searchRefresh}
          workstreams={workstreams}
          colors={colors}
          update={update}
          nextId={() => ++searchId.current}
        />
      </>
    );
  } else if (activeWs) {
    content = (
      <div class="single" data-section={activeWs.key}>
        {tool === 'chats' && <HooksNotice missing={activeWs.reachable && !activeWs.hasHooks ? 1 : 0} />}
        <WorktreeHeader ws={activeWs} tool={tool} />
        {activeWs.reachable ? <div class="sec-body">{body(activeWs)}</div> : <div class="empty">Not reachable from this environment.</div>}
      </div>
    );
  } else {
    content = (
      <>
        {tool === 'chats' && <HooksNotice missing={workstreams.filter((w) => w.reachable && !w.hasHooks).length} />}
        {workstreams.map((ws) => (
          <Section
            key={ws.key}
            ws={ws}
            tool={tool}
            color={colors.get(ws.key)!}
            collapsed={persisted.collapsed.includes(ws.key)}
            onToggle={() =>
              update((p) => ({ ...p, collapsed: p.collapsed.includes(ws.key) ? p.collapsed.filter((c) => c !== ws.key) : [...p.collapsed, ws.key] }))
            }
            onSelect={() => setActive(ws.key)}
          >
            {body(ws)}
          </Section>
        ))}
      </>
    );
  }

  return (
    <div class="app" style={{ '--ws-color': activeWs ? colors.get(activeWs.key) : 'var(--focus)' }}>
      <div class="wt-tabs" role="tablist" aria-label="Worktrees">
        <button class="wt-tab all" role="tab" aria-selected={active === ALL} data-tip="All Worktrees" data-keys="Ctrl+Alt+0" onClick={() => setActive(ALL)}>
          <i class="codicon codicon-layers" />
          <span class="nm">All</span>
        </button>
        {/* The arrows show only when there are hidden tabs that way. */}
        {overflow.left && (
          <button class="wt-nav" aria-label="Scroll Tabs Left" onClick={() => scrollTabs(-1)}>
            <i class="codicon codicon-chevron-left" />
          </button>
        )}
        {/* Only the worktree tabs scroll; All, the arrows and + stay in place. */}
        <div
          class="wt-scroll"
          ref={tabStrip}
          onScroll={measureTabs}
          onWheel={(e) => {
            // A mouse wheel scrolls the tabs sideways, like editor tabs.
            if (e.deltaY && !e.deltaX) {
              (e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}
        >
          {workstreams
            .filter((ws) => !closed.has(ws.key))
            .map((ws, i) => {
              const open = ws.chats.filter((c) => c.open).length;
              const dot = ATTENTION_DOT[ws.attention];
              const close = () => {
                setClosed((c) => new Set([...c, ws.key]));
                run('flotilla.closeTab', { key: ws.key });
              };
              return (
                <div
                  key={ws.key}
                  class={`wt-tab${ws.reachable ? '' : ' unreachable'}`}
                  role="tab"
                  tabIndex={0}
                  aria-selected={active === ws.key}
                  style={{ '--ws-color': colors.get(ws.key) }}
                  data-tip-ws={ws.key}
                  data-keys={i < 9 ? `Ctrl+Alt+${i + 1}` : undefined}
                  data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context, flotillaTab: tool, flotillaTabItem: true })}
                  onClick={() => setActive(ws.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setActive(ws.key);
                    else if (e.key === 'Delete') close();
                    else return;
                    e.preventDefault();
                  }}
                  onAuxClick={(e) => {
                    // Middle-click closes, like editor tabs.
                    if (e.button === 1) {
                      e.preventDefault();
                      close();
                    }
                  }}
                >
                  <span class="nm">{ws.label}</span>
                  {dot && <span class={`dot ${dot}`} />}
                  {open > 0 && <span class="n">{open}</span>}
                  <button
                    class="tab-close"
                    data-tip="Close Tab (the worktree stays in the Overview)"
                    aria-label={`Close ${ws.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close();
                    }}
                  >
                    <i class="codicon codicon-close" />
                  </button>
                </div>
              );
            })}
        </div>
        {overflow.right && (
          <button class="wt-nav" aria-label="Scroll Tabs Right" onClick={() => scrollTabs(1)}>
            <i class="codicon codicon-chevron-right" />
          </button>
        )}
        <button class="wt-add" aria-label="New Workstream…" onClick={() => run('flotilla.newWorkstream')}>
          <i class="codicon codicon-add" />
        </button>
      </div>
      <div class="body">
        <nav class="tools" role="tablist" aria-orientation="vertical" aria-label="Tools">
          {TOOLS.map((t) => {
            const badge = t.id === 'vc' ? changeCount : t.id === 'chats' ? waitingCount : 0;
            return (
              <Fragment key={t.id}>
                <button
                  role="tab"
                  aria-selected={tool === t.id}
                  aria-label={t.label}
                  data-tip-pos="right"
                  onClick={() => update((p) => ({ ...p, tool: t.id }))}
                >
                  <i class={`codicon codicon-${t.icon}`} />
                  {badge > 0 && <span class={`b${t.id === 'chats' ? ' alert' : ''}`}>{badge}</span>}
                </button>
                {t.id === 'vc' && tool === 'vc' && (
                  <div class="sub-tools" role="tablist" aria-orientation="vertical" aria-label="Version Control views">
                    {VC_VIEWS.map((v) => (
                      <button
                        key={v.id}
                        class="sub-tool"
                        role="tab"
                        aria-selected={vcView === v.id}
                        aria-label={`Version Control: ${v.label}`}
                        data-tip={v.label}
                        data-tip-pos="right"
                        onClick={() => update((p) => ({ ...p, vcView: v.id }))}
                      >
                        <i class={`codicon codicon-${v.icon}`} />
                      </button>
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
          <span class="grow" />
          <button aria-label="Run and Debug" data-tip-pos="right" onClick={() => send({ type: 'openView', view: 'debug' })}>
            <i class="codicon codicon-debug-alt" />
          </button>
          <button aria-label="Extensions" data-tip-pos="right" onClick={() => send({ type: 'openView', view: 'extensions' })}>
            <i class="codicon codicon-extensions" />
          </button>
        </nav>
        <div class="content">{content}</div>
      </div>
      <Hover
        render={(el) => {
          if (el.dataset.tipCommit) {
            const commit = logs.get(el.dataset.tipKey ?? '')?.commits.find((c) => c.hash === el.dataset.tipCommit);
            return commit && <CommitCard commit={commit} />;
          }
          const ws = el.dataset.tipWs ? workstreams.find((w) => w.key === el.dataset.tipWs) : undefined;
          return ws && <WorktreeCard ws={ws} color={colors.get(ws.key) ?? 'var(--focus)'} keys={el.dataset.keys} hint={el.dataset.tipHint} />;
        }}
      />
    </div>
  );
}
