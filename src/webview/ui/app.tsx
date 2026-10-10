import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DirEntry, HostMessage, Tab, WorkstreamView } from '../protocol';
import { menuContext, run, send, vscode } from './api';
import { ChatsBody, HooksNotice } from './chats';
import { FilesBody, type Editing } from './files';
import { Section } from './section';
import { VcBody } from './vc';

/** UI state that survives reloads of the webview (VS Code keeps it per view). */
export interface Persisted {
  tab: Tab;
  /** Focus mode: only this workstream is shown. */
  focus?: string;
  /** Collapsed sections (workstream keys). */
  collapsed: string[];
  /** Expanded folders per workstream key. */
  expanded: Record<string, string[]>;
  /** Commit message drafts per workstream key. */
  drafts: Record<string, string>;
  /** Workstream keys whose chat history is open. */
  history: string[];
}

const INITIAL: Persisted = { tab: 'files', collapsed: [], expanded: {}, drafts: {}, history: [] };

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

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'vc', label: 'Version Control', icon: 'source-control' },
  { id: 'chats', label: 'Chats', icon: 'comment-discussion' },
];

/** Worktree colors, from the theme's terminal palette so they suit every theme. */
const COLORS = ['blue', 'green', 'magenta', 'yellow', 'cyan', 'red', 'brightBlue', 'brightMagenta'];

/** A color per worktree, distinct for up to eight of them and stable while the set of worktrees stays the same. */
function colorsFor(workstreams: readonly WorkstreamView[]): Map<string, string> {
  const keys = workstreams.map((w) => w.key).sort();
  return new Map(keys.map((k, i) => [k, `var(--vscode-terminal-ansi${COLORS[i % COLORS.length][0].toUpperCase()}${COLORS[i % COLORS.length].slice(1)})`]));
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

function sectionElement(key: string): HTMLElement | null {
  return document.querySelector(`[data-section="${CSS.escape(key)}"]`);
}

export function App() {
  const [persisted, setPersisted] = useState<Persisted>(() => ({ ...INITIAL, ...((vscode.getState() as Partial<Persisted> | undefined) ?? {}) }));
  const [workstreams, setWorkstreams] = useState<WorkstreamView[] | undefined>(undefined);
  const [dirs, setDirs] = useState<Map<string, DirEntry[]>>(new Map());
  const [highlight, setHighlight] = useState<Highlight | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [inView, setInView] = useState<string | undefined>(undefined);
  const [flash, setFlash] = useState<string | undefined>(undefined);
  const requested = useRef(new Set<string>());
  const content = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ key: string; path?: string; until: number } | undefined>(undefined);
  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;

  const update: Update = useCallback((change) => {
    setPersisted((prev) => {
      const next = change(prev);
      vscode.setState(next);
      return next;
    });
  }, []);

  const requestDir = useCallback((key: string, path: string) => {
    const k = dirKey(key, path);
    if (requested.current.has(k)) return;
    requested.current.add(k);
    send({ type: 'listDir', key, path });
  }, []);

  const scrollToSection = useCallback((key: string) => {
    pendingScroll.current = { key, until: Date.now() + 3000 };
    setFlash(key);
    setTimeout(() => setFlash((f) => (f === key ? undefined : f)), 900);
  }, []);

  const onMessage = useCallback(
    (m: HostMessage) => {
      switch (m.type) {
        case 'state':
          setWorkstreams(m.workstreams);
          return;
        case 'dir':
          setDirs((prev) => new Map(prev).set(dirKey(m.key, m.path), m.entries));
          return;
        case 'dirsChanged':
          for (const path of m.paths) {
            const k = dirKey(m.key, path);
            if (requested.current.delete(k)) requestDir(m.key, path);
          }
          return;
        case 'tab':
          update((p) => ({ ...p, tab: m.tab }));
          return;
        case 'edit': {
          // Open the folder the new item goes into (or the renamed item's folder), in the Files tab.
          const dir = m.kind === 'rename' ? m.path.split('/').slice(0, -1).join('/') : m.dir;
          const dirs = dir ? [...ancestors(`${dir}/x`)] : [];
          update((prev) => ({
            ...prev,
            tab: 'files',
            focus: prev.focus && prev.focus !== m.key ? undefined : prev.focus,
            collapsed: prev.collapsed.filter((c) => c !== m.key),
            expanded: { ...prev.expanded, [m.key]: [...new Set([...(prev.expanded[m.key] ?? []), ...dirs])] },
          }));
          for (const d of ['', ...dirs]) requestDir(m.key, d);
          setEditing(m.kind === 'rename' ? { key: m.key, kind: 'rename', path: m.path } : { key: m.key, kind: m.kind, dir: m.dir });
          return;
        }
        case 'editResult':
          setEditing((e) => (m.ok ? undefined : e && { ...e, error: m.error }));
          return;
        case 'committed':
          update((p) => {
            const drafts = { ...p.drafts };
            delete drafts[m.key];
            return { ...p, drafts };
          });
          return;
        case 'reveal': {
          const p = persistedRef.current;
          if (m.path === undefined) {
            // Reveal a workstream: leave focus mode if it hides it, open its section, scroll to it.
            update((prev) => ({
              ...prev,
              tab: m.tab ?? prev.tab,
              focus: prev.focus && prev.focus !== m.key ? undefined : prev.focus,
              collapsed: prev.collapsed.filter((c) => c !== m.key),
            }));
            scrollToSection(m.key);
            return;
          }
          // Reveal the active editor's file, like the Explorer's auto-reveal: only in the Files tab, never out of focus mode.
          if (p.tab !== 'files' || (p.focus && p.focus !== m.key)) return;
          const parents = ancestors(m.path);
          update((prev) => ({
            ...prev,
            collapsed: prev.collapsed.filter((c) => c !== m.key),
            expanded: { ...prev.expanded, [m.key]: [...new Set([...(prev.expanded[m.key] ?? []), ...parents])] },
          }));
          for (const dir of ['', ...parents]) requestDir(m.key, dir);
          setHighlight({ key: m.key, path: m.path });
          pendingScroll.current = { key: m.key, path: m.path, until: Date.now() + 3000 };
          return;
        }
      }
    },
    [requestDir, scrollToSection, update],
  );

  useEffect(() => {
    const listener = (e: MessageEvent<HostMessage>) => onMessage(e.data);
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [onMessage]);

  // Escape leaves focus mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && persistedRef.current.focus) update((p) => ({ ...p, focus: undefined }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [update]);

  // Runs queued scrolls once their target is rendered (a revealed file may need folder listings first).
  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      pendingScroll.current = undefined;
      return;
    }
    if (pending.path === undefined) {
      const el = sectionElement(pending.key);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        pendingScroll.current = undefined;
      }
      return;
    }
    const row = sectionElement(pending.key)?.querySelector<HTMLElement>(`[data-path="${CSS.escape(pending.path)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      pendingScroll.current = undefined;
    }
  });

  // Scroll spy: outline the tile of the workstream at the top of the list.
  const onScroll = useCallback(() => {
    const box = content.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let current: string | undefined;
    for (const el of box.querySelectorAll<HTMLElement>('[data-section]')) {
      // Skip a section whose sticky header is all that's left of it.
      if (el.getBoundingClientRect().bottom > top + 40) {
        current = el.dataset.section;
        break;
      }
    }
    setInView(current);
  }, []);
  useEffect(onScroll, [workstreams, persisted.tab, persisted.focus, onScroll]);

  if (!workstreams) return <div class="empty">Loading worktrees…</div>;

  const { tab, focus } = persisted;
  const focused = focus ? workstreams.find((w) => w.key === focus) : undefined;
  const shown = focused ? [focused] : workstreams;
  const changeCount = workstreams.reduce((n, w) => n + w.staged.length + w.unstaged.length, 0);
  const waitingCount = workstreams.reduce((n, w) => n + w.chats.filter((c) => c.open && c.state === 'waiting-for-input').length, 0);
  const files: FilesApi = {
    dirs,
    requestDir,
    selected: highlight,
    select: (key, path) => setHighlight({ key, path }),
    editing,
    stopEditing: () => setEditing(undefined),
  };
  const colors = colorsFor(workstreams);

  return (
    <div class="app">
      <div class="tabs" role="tablist" aria-label="View">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            class="tab"
            aria-selected={tab === t.id}
            aria-label={t.label}
            title={t.label}
            onClick={() => update((p) => ({ ...p, tab: t.id }))}
          >
            <i class={`codicon codicon-${t.icon}`} />
            {t.id === 'vc' && changeCount > 0 && <span class="count quiet">{changeCount}</span>}
            {t.id === 'chats' && waitingCount > 0 && (
              <span class="count alert" title={`${waitingCount} chat(s) waiting for you`}>
                {waitingCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div class="body">
        <nav class="rail" aria-label="Worktrees">
          {workstreams.map((ws) => {
            const open = ws.chats.filter((c) => c.open).length;
            const dot = ATTENTION_DOT[ws.attention];
            return (
              <button
                key={ws.key}
                class={`tile${inView === ws.key && !focus ? ' in-view' : ''}${focus === ws.key ? ' focused' : ''}${ws.reachable ? '' : ' unreachable'}`}
                aria-pressed={focus === ws.key}
                style={{ '--ws-color': colors.get(ws.key) }}
                title={`${ws.tooltip}\n\nClick: scroll to it · Double-click: show only this worktree`}
                data-vscode-context={menuContext('workstream', { key: ws.key, flotillaWs: ws.context })}
                onClick={() => {
                  update((p) => ({ ...p, focus: p.focus && p.focus !== ws.key ? undefined : p.focus, collapsed: p.collapsed.filter((c) => c !== ws.key) }));
                  scrollToSection(ws.key);
                }}
                onDblClick={() => update((p) => ({ ...p, focus: p.focus === ws.key ? undefined : ws.key }))}
              >
                <span class="mono">
                  {ws.initials}
                  {dot && <span class={`dot ${dot}`} />}
                  {open > 0 && <span class="cnt">{open}</span>}
                </span>
              </button>
            );
          })}
          <div class="rail-sep" />
          <button class="tile add" title="New Workstream…" onClick={() => run('flotilla.newWorkstream')}>
            <span class="mono">
              <i class="codicon codicon-add" />
            </span>
          </button>
        </nav>
        <div class="content" ref={content} onScroll={onScroll}>
          {focused && (
            <div class="focus-bar">
              <i class="codicon codicon-eye" />
              <span>Only {focused.branch}</span>
              <button class="link" onClick={() => update((p) => ({ ...p, focus: undefined }))}>
                Show all
              </button>
            </div>
          )}
          {tab === 'chats' && <HooksNotice missing={shown.filter((w) => w.reachable && !w.hasHooks).length} />}
          {shown.map((ws) => (
            <Section
              key={ws.key}
              ws={ws}
              tab={tab}
              color={colors.get(ws.key)!}
              active={inView === ws.key || focus === ws.key}
              collapsed={persisted.collapsed.includes(ws.key)}
              flash={flash === ws.key}
              onToggle={() =>
                update((p) => ({ ...p, collapsed: p.collapsed.includes(ws.key) ? p.collapsed.filter((c) => c !== ws.key) : [...p.collapsed, ws.key] }))
              }
            >
              {tab === 'files' && <FilesBody ws={ws} files={files} expanded={persisted.expanded[ws.key] ?? []} update={update} />}
              {tab === 'vc' && <VcBody ws={ws} draft={persisted.drafts[ws.key] ?? ''} update={update} />}
              {tab === 'chats' && <ChatsBody ws={ws} historyOpen={persisted.history.includes(ws.key)} update={update} />}
            </Section>
          ))}
        </div>
      </div>
    </div>
  );
}
