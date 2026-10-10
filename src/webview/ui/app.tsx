import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ALL, type DirEntry, type HostMessage, type Tool, type WorkstreamView } from '../protocol';
import { menuContext, run, send, vscode } from './api';
import { ChatsBody, HooksNotice } from './chats';
import { FilesBody, type Editing } from './files';
import { Overview } from './overview';
import { INITIAL_SEARCH, SearchView, type SearchResults, type SearchState } from './search';
import { Section, WorktreeHeader } from './section';
import { VcBody } from './vc';

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
  search: SearchState;
}

const INITIAL: Persisted = { tool: 'files', collapsed: [], expanded: {}, drafts: {}, history: [], search: INITIAL_SEARCH };

export type Update = (change: (p: Persisted) => Persisted) => void;

export interface Highlight {
  key: string;
  path: string;
}

export interface FilesApi {
  dirs: ReadonlyMap<string, DirEntry[]>;
  requestDir(key: string, path: string): void;
  /** The selected row: clicked, or the active editor's file. */
  selected: Highlight | undefined;
  select(key: string, path: string): void;
  editing: Editing | undefined;
  stopEditing(): void;
}

export const dirKey = (key: string, path: string) => `${key}\n${path}`;

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

/** The tab label: the last part of the branch ("feature/login" → "login"). */
function shortName(ws: WorkstreamView): string {
  return ws.branch.split('/').filter(Boolean).pop() ?? ws.branch;
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function App() {
  const [persisted, setPersisted] = useState<Persisted>(() => ({ ...INITIAL, ...((vscode.getState() as Partial<Persisted> | undefined) ?? {}) }));
  const [workstreams, setWorkstreams] = useState<WorkstreamView[] | undefined>(undefined);
  const [active, setActiveState] = useState<string>(ALL);
  const [dirs, setDirs] = useState<Map<string, DirEntry[]>>(new Map());
  const [highlight, setHighlight] = useState<Highlight | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [results, setResults] = useState<SearchResults | undefined>(undefined);
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
          if (m.id === searchId.current) setResults({ id: m.id, groups: m.groups, truncated: m.truncated, error: m.error });
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
          setHighlight({ key: m.key, path: m.path });
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

  if (!workstreams) return <div class="empty">Loading worktrees…</div>;

  const { tool } = persisted;
  const colors = colorsFor(workstreams);
  const activeWs = active === ALL ? undefined : workstreams.find((w) => w.key === active);
  const scope = activeWs ? [activeWs] : workstreams;
  const changeCount = scope.reduce((n, w) => n + w.staged.length + w.unstaged.length, 0);
  const waitingCount = scope.reduce((n, w) => n + w.chats.filter((c) => c.open && c.state === 'waiting-for-input').length, 0);
  const files: FilesApi = {
    dirs,
    requestDir,
    selected: highlight,
    select: (key, path) => setHighlight({ key, path }),
    editing,
    stopEditing: () => setEditing(undefined),
  };
  const body = (ws: WorkstreamView) => (
    <>
      {tool === 'files' && <FilesBody ws={ws} files={files} expanded={persisted.expanded[ws.key] ?? []} update={update} />}
      {tool === 'vc' && <VcBody ws={ws} draft={persisted.drafts[ws.key] ?? ''} update={update} />}
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
        onSelect={(key) => {
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
      <div
        class="wt-tabs"
        role="tablist"
        aria-label="Worktrees"
        onWheel={(e) => {
          // A mouse wheel scrolls the tab strip sideways, like editor tabs.
          if (e.deltaY && !e.deltaX) {
            (e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}
      >
        <button class="wt-tab all" role="tab" aria-selected={active === ALL} title="All worktrees (Ctrl+Alt+0)" onClick={() => setActive(ALL)}>
          <i class="codicon codicon-layers" />
          <span class="nm">All</span>
        </button>
        {workstreams.map((ws, i) => {
          const open = ws.chats.filter((c) => c.open).length;
          const dot = ATTENTION_DOT[ws.attention];
          return (
            <button
              key={ws.key}
              class={`wt-tab${ws.reachable ? '' : ' unreachable'}`}
              role="tab"
              aria-selected={active === ws.key}
              style={{ '--ws-color': colors.get(ws.key) }}
              title={`${ws.tooltip}${i < 9 ? `\n\nCtrl+Alt+${i + 1}` : ''}`}
              data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context, flotillaTab: tool })}
              onClick={() => setActive(ws.key)}
            >
              <span class="swatch" />
              <span class="nm">{shortName(ws)}</span>
              {dot && <span class={`dot ${dot}`} />}
              {open > 0 && <span class="n">{open}</span>}
            </button>
          );
        })}
        <button class="wt-add" title="New Workstream…" onClick={() => run('flotilla.newWorkstream')}>
          <i class="codicon codicon-add" />
        </button>
      </div>
      <div class="body">
        <nav class="tools" role="tablist" aria-orientation="vertical" aria-label="Tools">
          {TOOLS.map((t) => {
            const badge = t.id === 'vc' ? changeCount : t.id === 'chats' ? waitingCount : 0;
            return (
              <button key={t.id} role="tab" aria-selected={tool === t.id} title={t.label} aria-label={t.label} onClick={() => update((p) => ({ ...p, tool: t.id }))}>
                <i class={`codicon codicon-${t.icon}`} />
                {badge > 0 && <span class={`b${t.id === 'chats' ? ' alert' : ''}`}>{badge}</span>}
              </button>
            );
          })}
          <span class="grow" />
          <button title="Run and Debug" aria-label="Run and Debug" onClick={() => send({ type: 'openView', view: 'debug' })}>
            <i class="codicon codicon-debug-alt" />
          </button>
          <button title="Extensions" aria-label="Extensions" onClick={() => send({ type: 'openView', view: 'extensions' })}>
            <i class="codicon codicon-extensions" />
          </button>
        </nav>
        <div class="content">{content}</div>
      </div>
    </div>
  );
}
