import { Fragment } from 'preact';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import {
  ALL,
  type AutopilotState,
  type BacklogItemView,
  type BacklogProblem,
  type CiView,
  type DirEntry,
  type HostMessage,
  type MachineState,
  type MergeQueueView,
  type NoteView,
  type RefComparison,
  type SlowStorageView,
  type TicketVcView,
  type Tool,
  type VcView,
  type WorkstreamView,
} from '../protocol';
import type { AgentChoice } from '../../features/backlog/backlog';
import type { ChangeKind } from '../../core/git/porcelain';
import {
  menuContext,
  run,
  send,
  vscode,
} from './api';
import { ChatsBody, HooksNotice } from './chats';
import { CiBody } from './ci';
import { FilesBody, type Editing } from './files';
import { Hover, WorktreeCard } from './hover';
import { setIconTheme } from './icons';
import { scopeState, scopeSummary } from '../../features/ci/summary';
import { Overview } from './overview';
import {
  INITIAL_SEARCH,
  type SearchResults,
  type SearchState,
  SearchView,
} from './search';
import { Section, WorktreeHeader } from './section';
import { BacklogView } from './backlog';
import { noteFinished } from './notes';
import { noteNeed } from '../../features/backlog/needs';
import { MetricsBody } from '../metrics/view';
import type { MetricsPeriod, MetricsView } from '../metricsProtocol';
import { finished, pruneBusy } from './backlogBusy';
import {
  TicketChangesBody,
  TicketCommitsBody,
  TicketHeader,
  ticketOf,
} from './ticketVc';
import {
  type CommitFiles,
  type CommitHighlight,
  type CompareChoice,
  CompareView,
  type Comparison,
  HistoryBody,
  type Log,
  type Refs,
  VcBody,
  withComparison,
} from './vc';

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
  /** Version Control › Compare's comparisons, newest first; the view shows only while there are any. */
  comparisons: CompareChoice[];
  nextComparison: number;
  search: SearchState;
  /** The backlog shows only the tickets being worked on. */
  workingOnly?: boolean;
  /** The Metrics tool's period (BL-158). */
  metricsPeriod?: MetricsPeriod;
  /** The autopilot's details are folded out (BL-153). */
  autopilotOpen?: boolean;
}

const INITIAL: Persisted = {
  tool: 'files',
  collapsed: [],
  expanded: {},
  drafts: {},
  history: [],
  vcView: 'changes',
  comparisons: [],
  nextComparison: 1,
  search: INITIAL_SEARCH,
};

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
  /** Each worktree's change marks (by path) of the entries in the folders listed, from all of its changes. */
  marks: ReadonlyMap<string, Record<string, ChangeKind>>;
  requestDir(key: string, path: string): void;
  selection: Selection | undefined;
  isSelected(key: string, path: string): boolean;
  /** single: just this row; toggle: add or remove it (Ctrl/Cmd); range: from the anchor to it (Shift). */
  select(key: string, path: string, mode: 'single' | 'toggle' | 'range'): void;
  /** The paths of a worktree's tree rows in the order shown (drawn or not): a range covers them. */
  publishRows(key: string, paths: string[]): void;
  editing: Editing | undefined;
  stopEditing(): void;
}

export const dirKey = (key: string, path: string) => `${key}\n${path}`;

/** Under Version Control in the tool strip, shown while it's the tool. */
const VC_VIEWS: Array<{ id: VcView; label: string; icon: string }> = [
  { id: 'changes', label: 'Changes', icon: 'diff' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'compare', label: 'Compare', icon: 'git-compare' },
  { id: 'ci', label: 'CI/CD', icon: 'github-action' },
];

const TOOLS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'backlog', label: 'Backlog', icon: 'checklist' },
  { id: 'metrics', label: 'Metrics', icon: 'graph' },
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
  const [machine, setMachine] = useState<MachineState | undefined>(undefined);
  const [active, setActiveState] = useState<string>(ALL);
  /** Worktrees whose tab is closed; they stay in the Overview. */
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [missingExclusions, setMissingExclusions] = useState<readonly string[]>([]);
  const [dirs, setDirs] = useState<Map<string, DirEntry[]>>(new Map());
  const [marks, setMarks] = useState<ReadonlyMap<string, Record<string, ChangeKind>>>(new Map());
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [results, setResults] = useState<SearchResults | undefined>(undefined);
  const [searchRefresh, setSearchRefresh] = useState(0);
  const [logs, setLogs] = useState<ReadonlyMap<string, Log>>(new Map());
  const [refs, setRefs] = useState<Refs | undefined>(undefined);
  const [backlog, setBacklog] = useState<BacklogItemView[] | undefined>(undefined);
  const [notes, setNotes] = useState<NoteView[]>([]);
  /** The CI/CD view of each worktree, by key. */
  const [ci, setCi] = useState<Record<string, CiView>>({});
  const [slow, setSlow] = useState<SlowStorageView | undefined>(undefined);
  const [metrics, setMetrics] = useState<{ view?: MetricsView; error?: string }>({});
  /** A ticket's commits to highlight in a worktree's history (clicked on the ticket). */
  const [highlight, setHighlight] = useState<CommitHighlight>();
  /** What the extension says is in progress, per tool. */
  const [progress, setProgress] = useState<Partial<Record<Tool, string[]>>>({});
  const [backlogInfo, setBacklogInfo] = useState<{
    problems: BacklogProblem[];
    integrations: number;
    autopilot?: AutopilotState;
    mergeQueue?: MergeQueueView;
    detailedCards?: boolean;
    agentDefaults?: AgentChoice;
  }>({ problems: [], integrations: 0 });
  /** Files of expanded commits, by worktree key and hash. */
  const [commitFiles, setCommitFiles] = useState<ReadonlyMap<string, CommitFiles>>(new Map());
  /** Tickets' changes and commits, for Version Control's ticket views (BL-171), by id (null: not a ticket). */
  const [ticketVcs, setTicketVcs] = useState<ReadonlyMap<string, TicketVcView | null>>(new Map());
  /** The file selected in a ticket's Changes (the one Expand was on), and the commit shown of its Commits, by id. */
  const [ticketFile, setTicketFile] = useState<Record<string, string>>({});
  const [ticketCommit, setTicketCommit] = useState<Record<string, string>>({});
  const [compareResults, setCompareResults] = useState<ReadonlyMap<number, Comparison>>(new Map());
  /** Request ids: the latest per comparison, and which comparison each one is for. */
  const compareRequests = useRef({ next: 0, latest: new Map<number, number>(), owner: new Map<number, number>() });
  const tabStrip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const searchId = useRef(0);
  const requested = useRef(new Set<string>());
  /** Each worktree's Files rows in the order they're shown: a Shift range covers them, drawn or not. */
  const treeOrder = useRef(new Map<string, string[]>());
  const stateRef = useRef({ persisted, active, workstreams });
  stateRef.current = { persisted, active, workstreams };

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

  const requestRefs = useCallback(() => {
    setRefs({ local: [], remote: [], tags: [] });
    send({ type: 'refs' });
  }, []);

  /** Compares; the list shown stays until the answer comes, and only the latest answer counts. */
  const compare = useCallback((comparisonId: number, request: RefComparison) => {
    const r = compareRequests.current;
    const id = ++r.next;
    r.latest.set(comparisonId, id);
    r.owner.set(id, comparisonId);
    setCompareResults((prev) => new Map(prev).set(comparisonId, { id, files: prev.get(comparisonId)?.files ?? [], loading: true }));
    send({ type: 'compare', id, ...request });
  }, []);

  const chooseCompare = useCallback(
    (id: number, change: Partial<CompareChoice>) => update((p) => ({ ...p, comparisons: p.comparisons.map((c) => (c.id === id ? { ...c, ...change } : c)) })),
    [update],
  );
  const closeCompare = useCallback(
    (id: number) =>
      update((p) => {
        const comparisons = p.comparisons.filter((c) => c.id !== id);
        // Closing the last one hides Compare; back to Changes.
        return { ...p, comparisons, vcView: !comparisons.length && p.vcView === 'compare' ? 'changes' : p.vcView };
      }),
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
          // Only the worktrees that changed come; the others keep their views (and the same objects, so nothing re-renders).
          setWorkstreams((prev) => {
            const views = new Map((prev ?? []).map((w) => [w.key, w]));
            for (const w of m.workstreams) views.set(w.key, w);
            const next = m.keys.flatMap((key) => views.get(key) ?? []);
            return prev && next.length === prev.length && next.every((w, i) => w === prev[i]) ? prev : next;
          });
          setMachine(m.machine);
          return;
        case 'active':
          setActiveState(m.key);
          return;
        case 'storage':
          setSlow(m.slow);
          return;
        case 'tabs':
          setClosed(new Set(m.closed));
          return;
        case 'exclusions':
          setMissingExclusions(m.missing);
          return;
        case 'dir':
          setDirs((prev) => new Map(prev).set(dirKey(m.key, m.path), m.entries));
          return;
        case 'marks':
          setMarks((prev) => new Map(prev).set(m.key, m.marks));
          return;
        case 'dirsChanged':
          for (const path of m.paths) {
            if (requested.current.delete(dirKey(m.key, path))) requestDir(m.key, path);
          }
          return;
        case 'tool':
          update((prev) => ({ ...prev, tool: m.tool }));
          return;
        case 'metricsView':
          setMetrics({ view: m.view });
          return;
        case 'metricsError':
          setMetrics((prev) => ({ ...prev, error: m.message }));
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
        case 'ci':
          setCi(m.views);
          return;
        case 'commitFiles':
          setCommitFiles((prev) => new Map(prev).set(`${m.key}\n${m.hash}`, { files: m.files, error: m.error }));
          return;
        case 'backlog':
          pruneBusy(new Set(m.items.map((i) => i.id)));
          setBacklog(m.items);
          setBacklogInfo({
            problems: m.problems,
            integrations: m.integrations,
            autopilot: m.autopilot,
            mergeQueue: m.mergeQueue,
            detailedCards: !!m.detailedCards,
            agentDefaults: m.agentDefaults,
          });
          return;
        case 'backlogDone':
          finished(m.message);
          return;
        case 'notes':
          setNotes(m.notes);
          return;
        case 'noteDone':
          noteFinished(m.message);
          return;
        case 'fold':
          update((prev) => ({ ...prev, collapsed: m.folded ? (stateRef.current.workstreams ?? []).map((w) => w.key) : [] }));
          return;
        case 'refs':
          setRefs({ defaultBase: m.defaultBase, local: m.local, remote: m.remote, tags: m.tags });
          return;
        case 'compared': {
          const r = compareRequests.current;
          const owner = r.owner.get(m.id);
          r.owner.delete(m.id);
          if (owner !== undefined && r.latest.get(owner) === m.id) {
            setCompareResults((prev) => new Map(prev).set(owner, { id: m.id, files: m.files, error: m.error }));
          }
          return;
        }
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
        case 'progress':
          setProgress(m.tools);
          return;
        case 'ticketVc':
          setTicketVcs((prev) => new Map(prev).set(m.id, m.view ?? null));
          return;
        case 'showTicketChanges':
          setActive(m.key);
          update((prev) => ({ ...prev, tool: 'vc', vcView: 'ticketChanges' }));
          setTicketFile((prev) => ({ ...prev, [m.ticket]: m.path }));
          send({ type: 'ticketVc', id: m.ticket });
          return;
        case 'showCommits':
          setActive(m.key);
          update((prev) => ({ ...prev, tool: 'vc', vcView: 'history', collapsed: prev.collapsed.filter((c) => c !== m.key) }));
          setHighlight({ key: m.key, ticket: m.ticket, hashes: new Set(m.hashes), selected: m.selected });
          return;
        case 'reveal': {
          if (m.path === undefined) {
            // A worktree to show (e.g. one just created): make it active.
            setActive(m.key);
            if (m.tool) update((prev) => ({ ...prev, tool: m.tool!, ...(m.vcView ? { vcView: m.vcView } : {}) }));
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

  // The Metrics tool asks for its period's numbers while it's shown (BL-158), and the host sends them again as events
  // come in; leaving it says so.
  const metricsShown = persisted.tool === 'metrics' ? (persisted.metricsPeriod ?? 'week') : undefined;
  useEffect(() => {
    if (!metricsShown) return;
    send({ type: 'metrics', period: metricsShown });
    return () => send({ type: 'metricsClosed' });
  }, [metricsShown]);

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

  // Fold All in the view title: offered where the All tab shows worktree sections.
  const sectioned =
    active === ALL &&
    ['files', 'search', 'vc', 'chats'].includes(persisted.tool) &&
    !(persisted.tool === 'vc' && persisted.vcView === 'compare' && persisted.comparisons.length > 0);
  const allFolded = sectioned && !!workstreams?.length && workstreams.every((w) => persisted.collapsed.includes(w.key));
  useEffect(() => send({ type: 'folding', canFold: sectioned, allFolded }), [sectioned, allFolded]);

  // The active worktree's ticket, for Version Control's header and ticket views: read again as its worktree changes.
  const shownWs = active === ALL ? undefined : workstreams?.find((w) => w.key === active);
  const shownTicket = ticketOf(shownWs, backlog);
  const ticketShown = persisted.tool === 'vc' && !!shownTicket;
  useEffect(() => {
    if (ticketShown && shownTicket) send({ type: 'ticketVc', id: shownTicket.id });
  }, [ticketShown, shownTicket?.id, shownWs]);

  if (!workstreams) return <div class="empty">Loading worktrees…</div>;

  const { tool } = persisted;
  // Compare shows only while there are comparisons, a ticket's views only for a ticket's worktree.
  const ticket = shownTicket;
  const vcView =
    (persisted.vcView === 'compare' && !persisted.comparisons.length) ||
    ((persisted.vcView === 'ticketChanges' || persisted.vcView === 'ticketCommits') && !ticket)
      ? 'changes'
      : persisted.vcView;
  const vcViews = [
    ...VC_VIEWS.filter((v) => v.id !== 'compare' || persisted.comparisons.length > 0),
    ...(ticket
      ? [
          { id: 'ticketChanges' as const, label: `${ticket.id}'s Changes`, icon: 'diff-multiple' },
          { id: 'ticketCommits' as const, label: `${ticket.id}'s Commits`, icon: 'git-commit' },
        ]
      : []),
  ];
  const ticketView = ticket ? (ticketVcs.get(ticket.id) ?? undefined) : undefined;
  // With the active worktree's branch, unless that's the base (main, or the All tab): then it's left to pick.
  const addComparison = () =>
    update((p) => withComparison(p, { base: refs?.defaultBase, head: activeWs && activeWs.branch !== refs?.defaultBase ? activeWs.branch : undefined }));
  // Views that + under Version Control can add: those not showing yet.
  const addable: AddableView[] = [
    {
      label: 'Compare Branches',
      detail: 'What differs between two branches',
      icon: 'git-compare',
      shown: persisted.comparisons.length > 0,
      add: addComparison,
    },
  ].filter((v) => !v.shown);
  const colors = colorsFor(workstreams);
  const activeWs = active === ALL ? undefined : workstreams.find((w) => w.key === active);
  const scope = activeWs ? [activeWs] : workstreams;
  const changeCount = scope.reduce((n, w) => n + w.totals.staged + w.totals.unstaged, 0);
  // Chats waiting for the user, in every worktree (a chat waits wherever it runs): approvals, and output to reply to.
  // A chat linked to several worktrees counts once.
  const pending = new Map<string, 'approval' | 'reply'>();
  for (const w of workstreams) for (const c of w.chats) if (c.awaiting) pending.set(c.id, c.awaiting);
  const approvals = [...pending.values()].filter((a) => a === 'approval').length;
  const replies = pending.size - approvals;
  const pendingTip = [
    ...(approvals ? [`${approvals} chat${approvals === 1 ? ' needs' : 's need'} your approval`] : []),
    ...(replies ? [`${replies} chat${replies === 1 ? ' waits' : 's wait'} for your reply`] : []),
  ];
  // The backlog's badge counts what waits on the user ("Needs you": tickets, and notes whose agent asks) and the agents' proposals.
  const backlogCount = (backlog ?? []).filter((i) => i.need || i.proposed).length + notes.filter((n) => noteNeed(n)).length;
  const searching = !!persisted.search.query.trim() && !!searchId.current && results?.id !== searchId.current;
  /** What's in progress for a tool, to show on its icon (and say in its hover). */
  const busyFor = (id: Tool): string[] => [...(progress[id] ?? []), ...(id === 'search' && searching ? ['Searching…'] : [])];
  /** CI of the scope (the active worktree, or all of them on the All tab): its state on the Version Control tool, and what failed. */
  const ciViews = active === ALL ? workstreams.map((w) => ci[w.key]) : [ci[active]];
  const ciState = scopeState(ciViews);
  const ciTip = scopeSummary(ciViews);
  const files: FilesApi = {
    dirs,
    marks,
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
        // A range covers the rows between the anchor and this one, in the order they are shown.
        const rows = treeOrder.current.get(key) ?? [];
        const [a, b] = [rows.indexOf(sel.anchor), rows.indexOf(path)].sort((x, y) => x - y);
        return a < 0 ? { key, paths: [path], anchor: path } : { key, paths: rows.slice(a, b + 1), anchor: sel.anchor };
      }),
    publishRows: (key, paths) => {
      treeOrder.current.set(key, paths);
    },
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
          highlight={highlight?.key === ws.key ? highlight : undefined}
          clearHighlight={() => setHighlight(undefined)}
          log={logs.get(ws.key)}
          requestLog={requestLog}
          files={(hash) => commitFiles.get(`${ws.key}\n${hash}`)}
          requestFiles={requestCommitFiles}
        />
      )}
      {tool === 'vc' && vcView === 'ci' && <CiBody view={ci[ws.key]} worktree={ws.key} />}
      {tool === 'vc' && vcView === 'ticketChanges' && ticket && (
        <TicketChangesBody
          ws={ws}
          view={ticketView}
          selected={ticketFile[ticket.id]}
          select={(path) => setTicketFile((prev) => ({ ...prev, [ticket.id]: path }))}
        />
      )}
      {tool === 'vc' && vcView === 'ticketCommits' && ticket && (
        <TicketCommitsBody
          ws={ws}
          view={ticketView}
          selected={ticketCommit[ticket.id]}
          select={(hash) => setTicketCommit((prev) => ({ ...prev, [ticket.id]: hash }))}
          files={(hash) => commitFiles.get(`${ws.key}\n${hash}`)}
          requestFiles={requestCommitFiles}
        />
      )}
      {tool === 'chats' && <ChatsBody ws={ws} historyOpen={persisted.history.includes(ws.key)} update={update} />}
    </>
  );

  let content;
  if (tool === 'backlog') {
    // The backlog is the repository's, whichever tab is active.
    content = (
      <BacklogView
        items={backlog}
        problems={backlogInfo.problems}
        integrations={backlogInfo.integrations}
        autopilot={backlogInfo.autopilot}
        agentDefaults={backlogInfo.agentDefaults}
        mergeQueue={backlogInfo.mergeQueue}
        notes={notes}
        workstreams={workstreams}
        colors={colors}
        workingOnly={!!persisted.workingOnly}
        setWorkingOnly={(on) => update((p) => ({ ...p, workingOnly: on }))}
        autopilotOpen={!!persisted.autopilotOpen}
        setAutopilotOpen={(open) => update((p) => ({ ...p, autopilotOpen: open }))}
        detailed={!!backlogInfo.detailedCards}
        setDetailed={(on) => {
          // Shown at once; the setting (flotilla.backlog.cards) keeps it.
          setBacklogInfo((b) => ({ ...b, detailedCards: on }));
          send({ type: 'backlog', op: 'cards', detailed: on });
        }}
        openWorktree={(key) => {
          setClosed((c) => new Set([...c].filter((k) => k !== key)));
          setActive(key);
          update((p) => ({ ...p, tool: 'files' }));
        }}
      />
    );
  } else if (tool === 'vc' && vcView === 'compare') {
    // Any two refs, whichever tab is active.
    content = (
      <CompareView
        workstreams={workstreams}
        colors={colors}
        comparisons={persisted.comparisons}
        refs={refs}
        results={compareResults}
        choose={chooseCompare}
        close={closeCompare}
        add={addComparison}
        requestRefs={requestRefs}
        compare={compare}
      />
    );
  } else if (tool === 'metrics') {
    // The repository's, whichever tab is active.
    const period = persisted.metricsPeriod ?? 'week';
    content = (
      <MetricsBody
        view={metrics.view?.period === period ? metrics.view : undefined}
        error={metrics.error}
        period={period}
        setPeriod={(p) => update((prev) => ({ ...prev, metricsPeriod: p }))}
        openTicket={(ticket) => send({ type: 'metricsOpen', ticket })}
        openChat={(session, cwd) => send({ type: 'metricsOpenChat', session, ...(cwd ? { cwd } : {}) })}
        openEditor={() => send({ type: 'metricsEditor', period })}
      />
    );
  } else if (tool === 'overview') {
    content = (
      <Overview
        workstreams={workstreams}
        machine={machine}
        active={active}
        colors={colors}
        closed={closed}
        ci={ci}
        missing={missingExclusions}
        slow={slow}
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
        {tool === 'vc' && ticket && <TicketHeader item={ticket} path={ticketFile[ticket.id]} />}
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
                  {ws.removing && <i class="codicon codicon-loading codicon-modifier-spin" data-tip="Removing…" aria-label="Removing…" />}
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
            const badge = t.id === 'vc' ? changeCount : t.id === 'chats' ? pending.size : t.id === 'backlog' ? backlogCount : 0;
            const busy = busyFor(t.id);
            return (
              <Fragment key={t.id}>
                <button
                  role="tab"
                  aria-selected={tool === t.id}
                  aria-label={t.label}
                  aria-busy={busy.length > 0}
                  data-tip={(() => {
                    const lines = [...busy, ...(t.id === 'chats' ? pendingTip : []), ...(t.id === 'vc' && ciTip ? [ciTip] : [])];
                    return lines.length ? [t.label, ...lines].join('\n') : undefined;
                  })()}
                  data-tip-pos="right"
                  onClick={() => update((p) => ({ ...p, tool: t.id }))}
                >
                  <i class={`codicon codicon-${t.icon}`} />
                  {t.id === 'vc' && ciState && <span class={`ci-dot ${ciState}`} />}
                  {badge > 0 && <span class={`b${t.id === 'chats' ? ' alert' : ''}`}>{badge}</span>}
                  {busy.length > 0 && (
                    <span class={`b busy${badge > 0 ? ' top' : ''}`}>
                      <i class="codicon codicon-sync" />
                    </span>
                  )}
                </button>
                {t.id === 'vc' && tool === 'vc' && (
                  <div class="sub-tools" role="tablist" aria-orientation="vertical" aria-label="Version Control views">
                    {vcViews.map((v) => (
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
                        {v.id === 'ci' && ciState && <span class={`ci-dot ${ciState}`} />}
                      </button>
                    ))}
                    {addable.length > 0 && <AddViewMenu views={addable} />}
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
          const ws = el.dataset.tipWs ? workstreams.find((w) => w.key === el.dataset.tipWs) : undefined;
          return ws && <WorktreeCard ws={ws} ci={ci[ws.key]} color={colors.get(ws.key) ?? 'var(--focus)'} keys={el.dataset.keys} hint={el.dataset.tipHint} />;
        }}
      />
    </div>
  );
}

interface AddableView {
  label: string;
  detail: string;
  icon: string;
  shown: boolean;
  add(): void;
}

/** + under Version Control: a menu of the views that can be added to it; gone once they all show. */
function AddViewMenu({ views }: { views: AddableView[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div class="add-view" ref={box}>
      <button class="sub-tool add" aria-label="Add a View…" aria-haspopup="menu" aria-expanded={open} data-tip-pos="right" onClick={() => setOpen(!open)}>
        <i class="codicon codicon-add" />
      </button>
      {open && (
        <div class="menu tool-menu" role="menu">
          {views.map((v) => (
            <button
              key={v.label}
              role="menuitem"
              ref={(el) => {
                if (views[0] === v) el?.focus();
              }}
              onClick={() => {
                setOpen(false);
                v.add();
              }}
            >
              <i class={`codicon codicon-${v.icon}`} />
              <span>
                <span class="menu-label">{v.label}</span>
                <span class="menu-detail">{v.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
