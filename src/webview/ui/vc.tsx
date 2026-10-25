import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import type {
  BacklogItemView,
  ChangeGroup,
  CommitView,
  FileChangeView,
  RefComparison,
  Tool,
  VcView,
  WorkstreamView,
} from '../protocol';
import { menuContext, run, send } from './api';
import type { Update } from './app';
import { CHANGE_LETTER } from './files';
import { fileIcon } from './icons';
import { Virtual } from './virtual';
import { ago } from './ago';
import { ticketOfCommit, ticketOfComparison } from './ticketOf';
import './vc.css';

export { ago };
import { historyRows, type HistoryRow } from './rows';

interface Props {
  ws: WorkstreamView;
  draft: string;
  update: Update;
}

/** A worktree's history as far as it's been read. */
export interface Log {
  /** The commit it was read from; a new HEAD means it's read again. */
  head?: string;
  commits: CommitView[];
  more: boolean;
  loading?: boolean;
  error?: string;
}

type CommitAction = { amend?: boolean; then?: 'push' | 'sync' };

const COMMIT_MENU: Array<{ label: string; action: CommitAction }> = [
  { label: 'Commit', action: {} },
  { label: 'Commit & Push', action: { then: 'push' } },
  { label: 'Commit & Sync', action: { then: 'sync' } },
  { label: 'Commit (Amend)', action: { amend: true } },
];

/** Like VS Code's Source Control: a message box at the top, and one primary button below it. */
function CommitBox({ ws, draft, update }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const changes = ws.totals.staged + ws.totals.unstaged;
  const setDraft = (value: string) => update((p) => ({ ...p, drafts: { ...p.drafts, [ws.key]: value } }));
  const commit = (action: CommitAction = {}) => {
    setMenuOpen(false);
    send({ type: 'commit', key: ws.key, message: draft, ...action });
  };
  const target = { key: ws.key };

  // The box grows with the message, up to ten lines, like VS Code's.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border (the box is border-box sized).
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, 10 * 18 + 8)}px`;
  }, [draft]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  let primary;
  if (changes > 0) {
    const what = ws.totals.staged ? `${ws.totals.staged} staged change(s)` : `all ${ws.totals.unstaged} change(s)`;
    primary = (
      <div class="split-button">
        <button class="button" data-tip={`Commit ${what} on ${ws.branch}`} onClick={() => commit()}>
          <i class="codicon codicon-check" />
          Commit
        </button>
        <button
          class="button more"
          aria-label="More Commit Actions…"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
        >
          <i class="codicon codicon-chevron-down" />
        </button>
        {menuOpen && (
          <div class="menu" role="menu">
            {COMMIT_MENU.map((item) => (
              <button key={item.label} role="menuitem" onClick={() => commit(item.action)}>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  } else if (ws.sync.kind === 'publish') {
    primary = (
      <button class="button wide" onClick={() => run('flotilla.publish', target)}>
        <i class="codicon codicon-cloud-upload" />
        Publish Branch
      </button>
    );
  } else if (ws.sync.kind === 'sync' && (ws.sync.ahead || ws.sync.behind)) {
    primary = (
      <button class="button wide" data-tip={`Pull ${ws.sync.behind} and push ${ws.sync.ahead} commit(s)`} onClick={() => run('flotilla.sync', target)}>
        <i class="codicon codicon-sync" />
        Sync Changes {ws.sync.behind > 0 && `${ws.sync.behind}↓`} {ws.sync.ahead > 0 && `${ws.sync.ahead}↑`}
      </button>
    );
  } else {
    primary = (
      <button class="button wide" disabled data-tip="There are no changes to commit">
        <i class="codicon codicon-check" />
        Commit
      </button>
    );
  }

  return (
    <div class="commit">
      <textarea
        ref={box}
        id={`msg-${ws.key}`}
        rows={1}
        value={draft}
        placeholder={`Message (Ctrl+Enter to commit on "${ws.branch}")`}
        aria-label={`Commit message for ${ws.branch}`}
        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && changes > 0) {
            e.preventDefault();
            commit();
          }
        }}
      />
      {primary}
    </div>
  );
}

/** Version Control › Changes: the commit box and the staged and unstaged changes. */
export function VcBody({ ws, draft, update }: Props) {
  const total = ws.totals.staged + ws.totals.unstaged;
  return (
    <div class="vc">
      <CommitBox ws={ws} draft={draft} update={update} />
      <Group ws={ws} group="staged" title="Staged Changes" items={ws.staged} total={ws.totals.staged} />
      <Group ws={ws} group="unstaged" title="Changes" items={ws.unstaged} total={ws.totals.unstaged} />
      {total === 0 && ws.sync.kind === 'sync' && !ws.sync.ahead && !ws.sync.behind && <div class="empty">Up to date with the remote.</div>}
    </div>
  );
}

/**
 * A group is always shown, also when empty, so the staged and unstaged lanes stay in place. Its rows are drawn as they
 * scroll into view; items is what the sidebar got (flotilla.changes.limit), total is every change in the group.
 */
function Group({ ws, group, title, items, total }: { ws: WorkstreamView; group: ChangeGroup; title: string; items: FileChangeView[]; total: number }) {
  const target = { key: ws.key, group };
  const more = total - items.length;
  return (
    <div class="group">
      <div class="row group-head" data-vscode-context={items.length ? menuContext('changeGroup', { key: ws.key, group, flotillaWs: ws.context }) : undefined}>
        <span class="name">{title}</span>
        <span class="hover-actions" hidden={!total}>
          <button class="icon" aria-label="Open Changes" onClick={() => run('flotilla.openChanges', target)}>
            <i class="codicon codicon-diff-multiple" />
          </button>
          {group === 'staged' ? (
            <button class="icon" aria-label="Unstage All Changes" onClick={() => run('flotilla.unstageAll', target)}>
              <i class="codicon codicon-remove" />
            </button>
          ) : (
            <>
              <button class="icon" aria-label="Discard All Changes" onClick={() => run('flotilla.discardAll', target)}>
                <i class="codicon codicon-discard" />
              </button>
              <button class="icon" aria-label="Stage All Changes" onClick={() => run('flotilla.stageAll', target)}>
                <i class="codicon codicon-add" />
              </button>
            </>
          )}
        </span>
        <span class="badge">{total}</span>
      </div>
      <Virtual items={items} keyOf={(c) => c.path} render={(c) => <ChangeRow ws={ws} group={group} change={c} />} />
      {more > 0 && (
        <div class="row group-empty">
          <span class="name">and {more.toLocaleString()} more</span>
          <button class="link" data-tip="A terminal here: git status lists every change" onClick={() => run('flotilla.openTerminal', { key: ws.key })}>
            Open Terminal
          </button>
        </div>
      )}
      {!total && <div class="row group-empty">{group === 'staged' ? 'No staged changes' : 'No changes'}</div>}
    </div>
  );
}

function ChangeRow({ ws, group, change }: { ws: WorkstreamView; group: ChangeGroup; change: FileChangeView }) {
  const parts = change.path.replace(/\/$/, '').split('/');
  const name = parts.pop()!;
  const target = { key: ws.key, path: change.path, group };
  const discardable = group === 'unstaged' && change.kind !== 'conflicted';
  return (
    <div
      class="row change"
      role="button"
      tabIndex={0}
      data-vscode-context={menuContext('change', { key: ws.key, path: change.path, group, discardable, flotillaWs: ws.context })}
      onClick={() => run('flotilla.openFileDiff', target)}
      onKeyDown={(e) => e.key === 'Enter' && run('flotilla.openFileDiff', target)}
    >
      <i class="codicon codicon-file" />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{change.files ? `${change.files.toLocaleString('en-US')} untracked file${change.files === 1 ? '' : 's'}` : parts.join('/')}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {change.kind !== 'deleted' && (
          <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', target)}>
            <i class="codicon codicon-go-to-file" />
          </button>
        )}
        {discardable && (
          <button class="icon" aria-label="Discard Changes" onClick={() => run('flotilla.discard', target)}>
            <i class="codicon codicon-discard" />
          </button>
        )}
        {group === 'staged' ? (
          <button class="icon" aria-label="Unstage Changes" onClick={() => run('flotilla.unstage', target)}>
            <i class="codicon codicon-remove" />
          </button>
        ) : (
          <button class="icon" aria-label="Stage Changes" onClick={() => run('flotilla.stage', target)}>
            <i class="codicon codicon-add" />
          </button>
        )}
      </span>
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

/**
 * Version Control › History: the worktree's commits, newest first. They're read when shown and again when HEAD or
 * the upstream moves; "Load more" reads older ones.
 */
/** The files a commit changed, once read. */
export interface CommitFiles {
  files: FileChangeView[];
  loading?: boolean;
  error?: string;
}

interface HistoryProps {
  ws: WorkstreamView;
  log: Log | undefined;
  requestLog(key: string, skip: number): void;
  files(hash: string): CommitFiles | undefined;
  requestFiles(key: string, hash: string): void;
  highlight?: CommitHighlight;
  clearHighlight(): void;
  /** For Open Ticket on a ticket's commits (BL-173). */
  backlog: BacklogItemView[] | undefined;
}

type TicketRef = Pick<BacklogItemView, 'id' | 'title'>;

/** Open Ticket (BL-173): what in Version Control is a ticket's leads to the ticket, at its Changes (at that file). */
function OpenTicket({ item, path }: { item: TicketRef; path?: string }) {
  return (
    <button
      class="open-ticket"
      data-tip={`Open ${item.id}, at its Changes${path ? ` (${path.split('/').pop()})` : ''}: ${item.title}`}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: 'backToTicket', id: item.id, ...(path ? { path } : {}) });
      }}
    >
      <i class="codicon codicon-issues" />
      {item.id}
    </button>
  );
}

/** A ticket's commits, highlighted in a history; selected: the one clicked on the ticket. */
export interface CommitHighlight {
  key: string;
  ticket: string;
  hashes: ReadonlySet<string>;
  selected: string;
}

/** How many pages a history loads, at most, to find a commit to show. */
const FIND_PAGES = 10;

export function HistoryBody({ ws, log, requestLog, files, requestFiles, highlight, clearHighlight, backlog }: HistoryProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (hash: string) => {
    const open = !expanded.has(hash);
    if (open) requestFiles(ws.key, hash);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(hash);
      else next.delete(hash);
      return next;
    });
  };
  const stamp = `${ws.sync.head}|${ws.sync.ahead}|${ws.sync.behind}`;
  useEffect(() => {
    requestLog(ws.key, 0);
  }, [stamp, ws.key, requestLog]);
  const commits = log?.commits ?? [];
  const outgoing = commits.filter((c) => c.outgoing).length;
  const found = !!highlight && commits.some((c) => c.hash === highlight.selected);
  // The commit to show may be further back: load pages until it's there (a few at most).
  useEffect(() => {
    if (highlight && log && !found && log.more && !log.loading && commits.length < FIND_PAGES * 50) requestLog(ws.key, commits.length);
  }, [highlight, found, log, commits.length, ws.key, requestLog]);
  useEffect(() => {
    if (!found || !highlight) return;
    // The commit clicked on the ticket opens, with its message and files.
    requestFiles(ws.key, highlight.selected);
    setExpanded((prev) => (prev.has(highlight.selected) ? prev : new Set(prev).add(highlight.selected)));
  }, [found, highlight?.selected]);
  const inTicket = highlight ? commits.filter((c) => highlight.hashes.has(c.hash)).length : 0;
  return (
    <div class="group history">
      <div class="row group-head">
        <span class="name">Commits</span>
        <span class="hover-actions">
          <button class="icon" aria-label="Refresh" onClick={() => requestLog(ws.key, 0)}>
            <i class="codicon codicon-refresh" />
          </button>
        </span>
        {outgoing > 0 && (
          <span class="badge outgoing" data-tip={`${outgoing} commit${outgoing === 1 ? '' : 's'} not pushed yet`}>
            {outgoing}↑
          </span>
        )}
      </div>
      {highlight && (
        <div class="row ticket-commits-note">
          <i class="codicon codicon-issues" />
          <span class="name">
            {inTicket} commit{inTicket === 1 ? '' : 's'} of {highlight.ticket}
            {!found && !log?.loading && ' (the one clicked is further back)'}
          </span>
          <button class="icon" aria-label="Stop Highlighting" onClick={clearHighlight}>
            <i class="codicon codicon-close" />
          </button>
        </div>
      )}
      {log?.error && <div class="row group-empty error">{log.error}</div>}
      {!log?.error && !commits.length && <div class="row group-empty">{log?.loading || !log ? 'Loading…' : 'No commits yet'}</div>}
      <Virtual<HistoryRow>
        items={historyRows(commits, expanded, files)}
        keyOf={(row) => row.key}
        reveal={found ? highlight?.selected : undefined}
        render={(row) => {
          const { commit } = row;
          const ticket = ticketOfCommit(commit, backlog);
          if (row.kind === 'file') return <CommitFileRow ws={ws} commit={commit} change={row.change} ticket={ticket} />;
          if (row.kind === 'details') return <CommitDetails commit={commit} files={files(commit.hash)} ticket={ticket} />;
          return (
            <CommitRow
              ws={ws}
              commit={commit}
              open={expanded.has(commit.hash)}
              onToggle={() => toggle(commit.hash)}
              mark={highlight?.selected === commit.hash ? 'selected' : highlight?.hashes.has(commit.hash) ? 'ticket' : undefined}
              ticket={ticket}
            />
          );
        }}
      />
      {log?.more && (
        <div class="row group-empty">
          <button class="link" disabled={log.loading} onClick={() => requestLog(ws.key, commits.length)}>
            {log.loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

/** A commit: click to expand it into its message and changed files. */
function CommitRow({
  ws,
  commit,
  open,
  onToggle,
  mark,
  ticket,
}: {
  ws: WorkstreamView;
  commit: CommitView;
  open: boolean;
  onToggle(): void;
  /** Part of a highlighted ticket, or the one selected on it. */
  mark?: 'ticket' | 'selected';
  ticket?: TicketRef;
}) {
  const icon = commit.parents.length > 1 ? 'git-merge' : 'git-commit';
  return (
    <div
      class={`row log-row${commit.outgoing ? ' outgoing' : ''}${mark ? ` mark-${mark}` : ''}`}
      role="treeitem"
      aria-expanded={open}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} chev`} />
      <i class={`codicon codicon-${icon}`} />
      <span class="name">{commit.subject}</span>
      {/* The worktree's own branch goes without saying here; the hover lists every ref. */}
      {commit.refs
        .filter((r) => r !== ws.branch)
        .slice(0, 2)
        .map((r) => (
          <span key={r} class={`ref${r.startsWith('tag: ') ? ' tag-ref' : r.includes('/') ? ' remote' : ''}`}>
            {r.replace(/^tag: /, '')}
          </span>
        ))}
      <span class="desc">{commit.author}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {ticket && (
          <button class="icon" aria-label={`Open ${ticket.id}`} onClick={() => send({ type: 'backToTicket', id: ticket.id })}>
            <i class="codicon codicon-issues" />
          </button>
        )}
        <button class="icon" aria-label="Open All Changes" onClick={() => send({ type: 'openCommit', key: ws.key, hash: commit.hash })}>
          <i class="codicon codicon-diff-multiple" />
        </button>
        <button class="icon" aria-label="Copy Commit Hash" onClick={() => send({ type: 'copy', text: commit.hash })}>
          <i class="codicon codicon-copy" />
        </button>
      </span>
    </div>
  );
}

/**
 * Under an expanded commit: the rest of its message and who and when. Its changed files follow as rows of their own
 * (or, while they're read or when there are none, a note here).
 */
function CommitDetails({ commit, files, ticket }: { commit: CommitView; files: CommitFiles | undefined; ticket?: TicketRef }) {
  const date = new Date(commit.date);
  return (
    <div class="commit-details" role="group" aria-label={commit.subject}>
      {commit.body && <div class="commit-body">{commit.body}</div>}
      <div class="commit-meta">
        <span>{commit.author}</span>
        <span data-tip={date.toLocaleString()}>{ago(commit.date)}</span>
        <button class="link" data-tip="Copy Commit Hash" onClick={() => send({ type: 'copy', text: commit.hash })}>
          {commit.short}
        </button>
        {commit.outgoing && <span class="outgoing-note">not pushed yet</span>}
        {ticket && <OpenTicket item={ticket} />}
      </div>
      {files?.error && <div class="row group-empty error">{files.error}</div>}
      {!files?.error && !files?.files.length && <div class="row group-empty">{!files || files.loading ? 'Loading…' : 'No file changes'}</div>}
    </div>
  );
}

function CommitFileRow({ ws, commit, change, ticket }: { ws: WorkstreamView; commit: CommitView; change: FileChangeView; ticket?: TicketRef }) {
  const parts = change.path.split('/');
  const name = parts.pop()!;
  const open = () => send({ type: 'openCommit', key: ws.key, hash: commit.hash, path: change.path });
  return (
    <div class="row change commit-file" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
      <i class={fileIcon(name)} />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        {ticket && (
          <button class="icon" aria-label={`Open ${ticket.id} at This File`} onClick={() => send({ type: 'backToTicket', id: ticket.id, path: change.path })}>
            <i class="codicon codicon-issues" />
          </button>
        )}
        {change.kind !== 'deleted' && (
          <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', { key: ws.key, path: change.path })}>
            <i class="codicon codicon-go-to-file" />
          </button>
        )}
      </span>
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}

/** Branches and tags to compare. */
export interface Refs {
  defaultBase?: string;
  local: string[];
  remote: string[];
  tags: string[];
}

/** The answer to a comparison's latest request. */
export interface Comparison {
  /** The request it answers; older answers are dropped. */
  id: number;
  files: FileChangeView[];
  loading?: boolean;
  error?: string;
}

/** One comparison in Version Control › Compare (several, like GitLens). */
export interface CompareChoice {
  id: number;
  base?: string;
  head?: string;
  /** When head is checked out in a worktree: compare that worktree's files, uncommitted changes included. */
  uncommitted: boolean;
  /** Shows only its header. */
  collapsed?: boolean;
  /** The ticket it was opened for (Open in Version Control, BL-173), and the file selected there; dropped as its refs change. */
  ticket?: string;
  path?: string;
}

/** Adds a comparison to the UI state and shows it. */
export function withComparison<P extends { comparisons: CompareChoice[]; nextComparison: number; tool: Tool; vcView: VcView }>(
  p: P,
  init: Partial<Omit<CompareChoice, 'id'>>,
): P {
  const choice: CompareChoice = { uncommitted: true, ...init, id: p.nextComparison };
  // Earlier ones fold away, so the new one is in view.
  const folded = p.comparisons.map((c) => ({ ...c, collapsed: true }));
  return { ...p, tool: 'vc', vcView: 'compare', comparisons: [choice, ...folded], nextComparison: p.nextComparison + 1 };
}

interface RefGroup {
  label: string;
  icon: string;
  refs: string[];
}

/**
 * A branch picker: a button with the chosen branch that opens a searchable list of the worktrees' branches, other
 * branches, remote branches and tags. Anything else typed (a commit, HEAD~2) can be used as is.
 */
function RefPicker({
  value,
  placeholder,
  groups,
  colorOf,
  onPick,
}: {
  value: string;
  placeholder: string;
  groups: RefGroup[];
  colorOf(ref: string): string | undefined;
  onPick(ref: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const needle = filter.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, refs: g.refs.filter((r) => r.toLowerCase().includes(needle)).slice(0, 50) })).filter((g) => g.refs.length);
  const flat = shown.flatMap((g) => g.refs);
  const typed = filter.trim();
  const options = typed && !flat.includes(typed) ? [...flat, typed] : flat;
  const pick = (ref: string) => {
    setOpen(false);
    setFilter('');
    if (ref && ref !== value) onPick(ref);
  };
  const icon = (ref: string) => groups.find((g) => g.refs.includes(ref))?.icon ?? 'git-commit';
  return (
    <div class="ref-picker" ref={box}>
      <button
        class={`ref-button${value ? '' : ' empty'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setAt(0);
        }}
      >
        <i class={`codicon codicon-${value ? icon(value) : 'git-branch'}`} style={value && colorOf(value) ? { color: colorOf(value) } : undefined} />
        <span class="ref-name">{value || placeholder}</span>
        <i class="codicon codicon-chevron-down" />
      </button>
      {open && (
        <div class="ref-menu" role="listbox">
          <input
            class="ref-filter"
            value={filter}
            placeholder="Search branches and tags, or type a commit"
            aria-label="Search branches"
            ref={(el) => el?.focus()}
            onInput={(e) => {
              setFilter((e.target as HTMLInputElement).value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setAt((n) => Math.min(n + 1, options.length - 1));
              else if (e.key === 'ArrowUp') setAt((n) => Math.max(n - 1, 0));
              else if (e.key === 'Enter') pick(options[at] ?? typed);
              else if (e.key === 'Escape') setOpen(false);
              else return;
              e.preventDefault();
            }}
          />
          <div class="ref-options">
            {shown.map((g) => (
              <div key={g.label}>
                <div class="ref-group">{g.label}</div>
                {g.refs.map((r) => (
                  <button
                    key={r}
                    role="option"
                    aria-selected={r === value}
                    class={`ref-option${options[at] === r ? ' active' : ''}`}
                    onMouseEnter={() => setAt(options.indexOf(r))}
                    onClick={() => pick(r)}
                  >
                    <i class={`codicon codicon-${g.icon}`} style={colorOf(r) ? { color: colorOf(r) } : undefined} />
                    <span>{r}</span>
                    {r === value && <i class="codicon codicon-check" />}
                  </button>
                ))}
              </div>
            ))}
            {typed && !flat.includes(typed) && (
              <button class={`ref-option${options[at] === typed ? ' active' : ''}`} onClick={() => pick(typed)}>
                <i class="codicon codicon-git-commit" />
                <span>
                  Use <strong>{typed}</strong>
                </span>
              </button>
            )}
            {!options.length && <div class="ref-group">No branches or tags</div>}
          </div>
        </div>
      )}
    </div>
  );
}

interface CompareViewProps {
  workstreams: WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  comparisons: CompareChoice[];
  refs: Refs | undefined;
  results: ReadonlyMap<number, Comparison>;
  choose(id: number, change: Partial<CompareChoice>): void;
  close(id: number): void;
  add(): void;
  requestRefs(): void;
  compare(id: number, request: RefComparison): void;
  backlog: BacklogItemView[] | undefined;
}

/**
 * Version Control › Compare: what differs between two branches (or tags, or commits), whichever tab is active.
 * Several comparisons can be open; closing the last one hides this view again.
 */
export function CompareView({ workstreams, colors, comparisons, refs, results, choose, close, add, requestRefs, compare, backlog }: CompareViewProps) {
  useEffect(() => {
    if (!refs) requestRefs();
  }, [refs, requestRefs]);
  return (
    <div class="compare">
      <div class="tool-title backlog-title">
        <span>Compare</span>
        <button class="icon" aria-label="New Comparison" onClick={add}>
          <i class="codicon codicon-add" />
        </button>
      </div>
      {comparisons.map((c) => (
        <ComparisonCard
          key={c.id}
          workstreams={workstreams}
          colors={colors}
          choice={c}
          refs={refs}
          result={results.get(c.id)}
          choose={(change) => choose(c.id, change)}
          close={() => close(c.id)}
          compare={(request) => compare(c.id, request)}
          ticket={ticketOfComparison(c, backlog)}
        />
      ))}
    </div>
  );
}

interface CardProps {
  workstreams: WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  choice: CompareChoice;
  refs: Refs | undefined;
  result: Comparison | undefined;
  choose(change: Partial<CompareChoice>): void;
  close(): void;
  compare(request: RefComparison): void;
  /** The ticket it's for: Open Ticket on it (BL-173). */
  ticket: Pick<BacklogItemView, 'id' | 'title'> | undefined;
}

function ComparisonCard({ workstreams, colors, choice, refs, result, choose, close, compare, ticket }: CardProps) {
  const base = choice.base ?? refs?.defaultBase ?? '';
  const head = choice.head ?? '';
  const worktree = workstreams.find((w) => w.reachable && w.branch === head);
  const withUncommitted = choice.uncommitted && worktree !== undefined;
  const request: RefComparison = { base, head, worktree: withUncommitted ? worktree!.key : undefined };
  // Again when the refs move, and for a worktree's files when they change.
  const stamp = [
    ...workstreams.map((w) => `${w.branch}@${w.sync.head}`),
    withUncommitted ? [...worktree!.staged, ...worktree!.unstaged].map((c) => `${c.kind}:${c.path}`).join(',') : '',
  ].join('|');
  useEffect(() => {
    if (base && head) compare(request);
  }, [base, head, request.worktree, stamp]);

  const worktreeBranches = workstreams.map((w) => w.branch).filter((b) => !b.startsWith('detached'));
  const groups: RefGroup[] = [
    { label: 'Worktrees', icon: 'git-branch', refs: worktreeBranches },
    { label: 'Branches', icon: 'git-branch', refs: (refs?.local ?? []).filter((r) => !worktreeBranches.includes(r)) },
    { label: 'Remote branches', icon: 'cloud', refs: refs?.remote ?? [] },
    { label: 'Tags', icon: 'tag', refs: refs?.tags ?? [] },
  ];
  const colorOf = (ref: string) => {
    const ws = workstreams.find((w) => w.branch === ref);
    return ws && colors.get(ws.key);
  };
  const files = result?.files ?? [];
  const open = (path?: string) => send({ type: 'openCompare', ...request, path });
  const title = base && head ? `${base} ↔ ${head}` : 'New comparison';
  return (
    <div class={`group comparison${choice.collapsed ? ' collapsed' : ''}`}>
      <div class="row group-head comparison-head" onClick={() => choose({ collapsed: !choice.collapsed })}>
        <i class={`codicon codicon-chevron-${choice.collapsed ? 'right' : 'down'} lane-chev-left`} />
        <span class="name" data-tip={title} data-tip-if-cut>
          {title}
        </span>
        {ticket && <OpenTicket item={ticket} path={choice.path} />}
        <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
          <button class="icon" aria-label="Open All Changes" disabled={!files.length} onClick={() => open()}>
            <i class="codicon codicon-diff-multiple" />
          </button>
          <button class="icon" aria-label="Refresh" disabled={!base || !head} onClick={() => compare(request)}>
            <i class="codicon codicon-refresh" />
          </button>
        </span>
        {result && !result.loading && !result.error && base && head && <span class="badge">{files.length}</span>}
        <button
          class="icon close"
          aria-label="Close Comparison"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      {!choice.collapsed && (
        <>
          <div class="compare-pick">
            <RefPicker value={base} placeholder="Pick a branch" groups={groups} colorOf={colorOf} onPick={(r) => choose({ base: r, ticket: undefined })} />
            <button class="icon compare-swap" aria-label="Swap" disabled={!base || !head} onClick={() => choose({ base: head, head: base, ticket: undefined })}>
              <i class="codicon codicon-arrow-swap" />
            </button>
            <RefPicker
              value={head}
              placeholder="Pick a branch to compare"
              groups={groups}
              colorOf={colorOf}
              onPick={(r) => choose({ head: r, ticket: undefined })}
            />
            {worktree && (
              <label class="check">
                <input type="checkbox" checked={choice.uncommitted} onChange={(e) => choose({ uncommitted: (e.target as HTMLInputElement).checked })} />
                With uncommitted changes in {worktree.label}
              </label>
            )}
          </div>
          {base && head && result?.error && <div class="row group-empty error">{result.error}</div>}
          {base && head && !result?.error && !files.length && <div class="row group-empty">{!result || result.loading ? 'Comparing…' : 'No differences'}</div>}
          {files.map((f) => (
            <CompareRow
              key={f.path}
              worktree={worktree?.key}
              change={f}
              open={() => open(f.path)}
              ticket={ticket?.id}
              selected={!!ticket && choice.path === f.path}
            />
          ))}
        </>
      )}
    </div>
  );
}

function CompareRow({
  worktree,
  change,
  open,
  ticket,
  selected,
}: {
  worktree: string | undefined;
  change: FileChangeView;
  open(): void;
  ticket?: string;
  selected?: boolean;
}) {
  const parts = change.path.split('/');
  const name = parts.pop()!;
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div
      ref={row}
      class={`row change${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <i class={fileIcon(name)} />
      <span class={`name k-${change.kind}`}>{name}</span>
      <span class="dir">{parts.join('/')}</span>
      {((worktree && change.kind !== 'deleted') || ticket) && (
        <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
          {ticket && (
            <button class="icon" aria-label={`Open ${ticket} at This File`} onClick={() => send({ type: 'backToTicket', id: ticket, path: change.path })}>
              <i class="codicon codicon-issues" />
            </button>
          )}
          {worktree && change.kind !== 'deleted' && (
            <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', { key: worktree, path: change.path })}>
              <i class="codicon codicon-go-to-file" />
            </button>
          )}
        </span>
      )}
      <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
    </div>
  );
}
