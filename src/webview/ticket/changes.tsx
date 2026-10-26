import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import type {
  ChangedFile,
  FileDiff,
  TicketHostMessage,
  TicketView,
} from '../ticketProtocol';
import { ActionButton, send } from './actions';
import './changes.css';
import {
  changeLetter,
  type ChangeRow,
  changeRows,
  type DiffRow,
  filterChange,
  rowWindow,
  sinceLastReview,
  withDiffs,
} from './changeTree';
import type { FullAt } from './diffView';

const ROW = 22;
const MAX_HEIGHT = 440;
/** With a diff unfolded, the list may grow taller, so a diff isn't read through a slot. */
const MAX_HEIGHT_DIFFS = 640;

/** The inline diffs' replies (readChangeDiff), by request. */
export const changeDiffReplies = new Map<number, (diff: FileDiff) => void>();
let nextDiff = 1;

function Counts({ added, deleted, binary }: { added: number; deleted: number; binary?: boolean }) {
  if (binary) return <span class="change-counts muted">binary</span>;
  return (
    <span class="change-counts">
      <span class="added">+{added}</span> <span class="deleted">−{deleted}</span>
    </span>
  );
}

const STAGE: Record<string, string> = {
  work: 'Compared with main where its branches split off',
  merged: 'Its merge into main',
  commits: 'Its commits on main, combined',
  picked: 'The commits picked, combined',
};

/**
 * What the ticket's work changes compared with main (BL-171), from a glance to the detail: its files as a tree that
 * folds by folder, each with its lines added and deleted; a file unfolds its diff inline (the preview); Expand (on a
 * file, or a hunk's head, at that line) shows the whole file's diff in the ticket's tab instead of the ticket
 * (DiffView, its header leading back here), and selects it in the sidebar's Version Control, on the ticket's Changes;
 * Open All Changes opens them all in the multi-file diff editor beside the ticket. The file expanded last stays marked
 * (marked), and Back to Ticket in a diff editor's title bar comes back here too.
 */
export function Changes({ ticket, expand, marked }: { ticket: TicketView; expand: (at: FullAt) => void; marked?: string }) {
  /** The path filter (BL-174): it narrows the list and its counts here; the commits picked narrow them on the host. */
  const [filter, setFilter] = useState('');
  const whole = ticket.changes;
  const change = useMemo(() => whole && filterChange(whole, filter), [whole, filter]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  /** The file whose diff was opened last (marked), and one to scroll to once its row is there. */
  const [current, setCurrent] = useState<string>();
  const [reveal, setReveal] = useState<{ path?: string }>();
  /** The files whose diffs are unfolded inline (their rows' keys), and the diffs read (until the change is new). */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [diffs, setDiffs] = useState<ReadonlyMap<string, FileDiff>>(new Map());
  /** The long hunks shown whole (their heads' keys), until the change is new. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (marked) setCurrent(marked);
  }, [marked]);
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const listener = (e: MessageEvent<TicketHostMessage>) => {
      if (e.data.type !== 'showChange') return;
      const path = e.data.path;
      if (path) {
        setCurrent(path);
        // The folders (and branch) it's in unfold.
        setFolded((f) => new Set([...f].filter((k) => !path.startsWith(k.slice(k.indexOf(':') + 1)))));
      }
      setReveal({ path });
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  const read = (key: string, group: number, path: string) => {
    const requestId = nextDiff++;
    changeDiffReplies.set(requestId, (diff) => setDiffs((d) => new Map(d).set(key, diff)));
    send({ type: 'readChangeDiff', requestId, group, path });
  };
  // A new change (a commit, an edit in the worktree): the unfolded diffs are read again; the others when they unfold.
  // (Not when the path filter changes: the diffs are the same.)
  useEffect(() => {
    setDiffs(new Map());
    setOpened(new Set());
    if (!whole) return;
    for (const key of unfolded) {
      const [g, ...rest] = key.split(':');
      const path = rest.join(':');
      if (whole.groups[Number(g)]?.files.some((f) => f.path === path)) read(key, Number(g), path);
    }
  }, [whole]);
  const rows = useMemo(() => (change ? withDiffs(changeRows(change, folded), unfolded, diffs, opened) : []), [change, folded, unfolded, diffs, opened]);
  const openHunk = (hunk: string) => setOpened(new Set([...opened, hunk]));
  const toggle = (key: string) => {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    setFolded(next);
  };
  const unfold = (key: string, group: number, path: string) => {
    const next = new Set(unfolded);
    if (!next.delete(key)) {
      next.add(key);
      if (!diffs.has(key)) read(key, group, path);
    }
    setUnfolded(next);
  };
  const height = Math.min(rows.length * ROW, unfolded.size ? MAX_HEIGHT_DIFFS : MAX_HEIGHT);
  const { start, end } = rowWindow(rows.length, scrollTop, height, ROW);
  useEffect(() => {
    if (!reveal || !change) return;
    const index = reveal.path ? rows.findIndex((r) => r.kind === 'file' && r.file.path === reveal.path) : -1;
    if (index >= 0 && list.current) list.current.scrollTop = Math.max(0, index * ROW - height / 2);
    section.current?.scrollIntoView({ block: 'start' });
    setReveal(undefined);
  }, [reveal, rows, change]);
  const open = (group: number, path: string, line?: number) => {
    setCurrent(path);
    send({ type: 'openChange', group, path, line });
  };
  return (
    <section class="block changes" ref={section}>
      <div class="block-head">
        <h2>
          Changes{' '}
          {change && change.files > 0 && (
            <span class="muted changes-total" title={STAGE[change.stage]}>
              {change.files} file{change.files === 1 ? '' : 's'} <Counts added={change.added} deleted={change.deleted} />
            </span>
          )}
        </h2>
        {change && change.files > 0 && (
          <ActionButton
            class="text-button"
            message={{ type: 'openAllChanges', ...(filter.trim() ? { filter } : {}) }}
            working="Opening…"
            title="Open them all in the multi-file diff editor, beside the ticket"
          >
            <i class="codicon codicon-diff-multiple" /> Open All Changes
          </ActionButton>
        )}
      </div>
      {whole && (whole.files > 0 || whole.picked || filter) && ticket.commits.length + whole.files > 0 && (
        <Narrow ticket={ticket} filter={filter} setFilter={setFilter} />
      )}
      <div class="work">
        {!change ? (
          <div class="work-empty muted">Reading the changes…</div>
        ) : !change.files ? (
          <div class="work-empty muted">
            {filter.trim() ? 'No changed file matches the filter' : whole?.picked ? 'The commits picked change no files' : 'No changes yet'}
          </div>
        ) : (
          <>
            {change.groups.length === 1 && <div class="changes-compared muted">{change.groups[0].compared}</div>}
            <div class="change-rows" ref={list} style={{ height: `${height}px` }} onScroll={(e) => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}>
              <div style={{ height: `${rows.length * ROW}px`, position: 'relative' }}>
                {rows.slice(start, end).map((r, i) => (
                  <Row
                    key={r.key}
                    row={r}
                    top={(start + i) * ROW}
                    ticket={ticket}
                    toggle={toggle}
                    unfold={unfold}
                    unfolded={unfolded}
                    open={open}
                    openHunk={openHunk}
                    expand={expand}
                    current={current}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Narrowing the Changes (BL-174): to some of the ticket's commits (newest first; "Since my last review" picks those
 * after your last entry), and by path.
 */
function Narrow({ ticket, filter, setFilter }: { ticket: TicketView; filter: string; setFilter: (f: string) => void }) {
  const picked = useMemo(() => new Set(ticket.changes?.picked ?? []), [ticket.changes]);
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  // A click elsewhere closes the list.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !picker.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  /** The commits asked for, until the change read from them comes. */
  const [asked, setAsked] = useState<string[]>();
  useEffect(() => setAsked(undefined), [ticket.changes]);
  const since = useMemo(() => sinceLastReview(ticket.commits, ticket.activity), [ticket.commits, ticket.activity]);
  const pick = (commits: string[]) => {
    setAsked(commits);
    send({ type: 'narrowChanges', commits });
  };
  const shown = asked ? new Set(asked) : picked;
  const toggle = (hash: string) => {
    const next = new Set(shown);
    if (!next.delete(hash)) next.add(hash);
    pick(ticket.commits.filter((c) => next.has(c.hash)).map((c) => c.hash));
  };
  const same = (list: string[]) => list.length === shown.size && list.every((h) => shown.has(h));
  const label = !shown.size ? 'All commits' : same(since) ? 'Since my last review' : `${shown.size} commit${shown.size === 1 ? '' : 's'}`;
  return (
    <div class="changes-narrow">
      {ticket.commits.length > 0 && (
        <div class="changes-picker" ref={picker} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <button
            class={`text-button${shown.size ? ' narrowed' : ''}`}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title="Show what some of its commits changed"
          >
            <i class="codicon codicon-git-commit" /> {label}
            {asked && '…'} <i class={`codicon codicon-chevron-${open ? 'up' : 'down'}`} />
          </button>
          {open && (
            <div class="changes-commits" role="menu">
              <button class={`changes-commit${!shown.size ? ' on' : ''}`} onClick={() => pick([])}>
                <i class="codicon codicon-git-compare" /> All of its change
              </button>
              <button
                class={`changes-commit${shown.size && same(since) ? ' on' : ''}`}
                onClick={() => pick(since)}
                disabled={!since.length}
                title={
                  since.length
                    ? `The ${since.length} commit${since.length === 1 ? '' : 's'} after your last entry in the ticket`
                    : 'No commits since your last entry in the ticket'
                }
              >
                <i class="codicon codicon-history" /> Since my last review{since.length > 0 && <span class="muted"> ({since.length})</span>}
              </button>
              {ticket.commits.map((c) => (
                <label key={c.hash} class="changes-commit" title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}`}>
                  <input type="checkbox" checked={shown.has(c.hash)} onChange={() => toggle(c.hash)} />
                  <span class="muted commit-hash">{c.short}</span>
                  <span class="change-name">{c.subject}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <span class="changes-filter">
        <i class="codicon codicon-filter" />
        <input
          type="text"
          value={filter}
          placeholder="Filter by path (src/core *.test.ts)"
          aria-label="Filter the changed files by path"
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
        />
      </span>
    </div>
  );
}

function Row({
  row,
  top,
  ticket,
  toggle,
  unfold,
  unfolded,
  open,
  openHunk,
  expand,
  current,
}: {
  row: ChangeRow | DiffRow;
  top: number;
  ticket: TicketView;
  toggle: (key: string) => void;
  unfold: (key: string, group: number, path: string) => void;
  unfolded: ReadonlySet<string>;
  open: (group: number, path: string, line?: number) => void;
  openHunk: (hunk: string) => void;
  expand: (at: FullAt) => void;
  current?: string;
}) {
  const style = { top: `${top}px`, height: `${ROW}px` };
  if (row.kind === 'group') {
    const g = ticket.changes!.groups[row.group];
    return (
      <button class="change-row change-group" style={style} onClick={() => toggle(row.key)} aria-expanded={row.open} title={g.compared}>
        <i class={`codicon codicon-chevron-${row.open ? 'down' : 'right'}`} />
        <i class="codicon codicon-git-branch" />
        <span class="change-name">{g.label}</span>
        <span class="muted">
          {g.files.length} file{g.files.length === 1 ? '' : 's'}
          {g.uncommitted > 0 && `, ${g.uncommitted} uncommitted`}
        </span>
        <Counts added={g.added} deleted={g.deleted} />
      </button>
    );
  }
  const indent = { paddingLeft: `${8 + row.depth * 14}px` };
  if (row.kind === 'folder') {
    return (
      <button
        class="change-row"
        style={{ ...style, ...indent }}
        onClick={() => toggle(row.key)}
        aria-expanded={row.open}
        title={`${row.count} file${row.count === 1 ? '' : 's'}`}
      >
        <i class={`codicon codicon-chevron-${row.open ? 'down' : 'right'}`} />
        <i class="codicon codicon-folder" />
        <span class="change-name">{row.name}</span>
        <Counts added={row.added} deleted={row.deleted} />
      </button>
    );
  }
  if (row.kind === 'hunk') {
    return (
      <div class="change-row change-hunk" style={{ ...style, ...indent }}>
        <span class="change-name">{row.label}</span>
        <button
          class="change-action"
          onClick={() => expand({ group: row.group, path: row.path, line: row.line })}
          title={`Expand: the whole file's diff, at line ${row.line}`}
        >
          <i class="codicon codicon-screen-full" /> Expand
        </button>
        <button
          class="change-action"
          onClick={() => open(row.group, row.path, row.line)}
          title={`In VS Code's diff editor, beside the ticket, at line ${row.line}`}
        >
          <i class="codicon codicon-split-horizontal" /> Open at Line {row.line}
        </button>
      </div>
    );
  }
  if (row.kind === 'more') {
    return (
      <button class="change-row change-more" style={{ ...style, ...indent }} onClick={() => openHunk(row.hunk)} title="Show the hunk's other lines">
        <i class="codicon codicon-unfold" />
        <span class="change-name">
          {row.count} more line{row.count === 1 ? '' : 's'}
        </span>
      </button>
    );
  }
  if (row.kind === 'note') {
    return (
      <div class="change-row change-note muted" style={{ ...style, ...indent }}>
        <span class="change-name">{row.text}</span>
        <button class="change-action" onClick={() => open(row.group, row.path)} title="In VS Code's diff editor, beside the ticket">
          <i class="codicon codicon-split-horizontal" /> Open in Diff Editor
        </button>
      </div>
    );
  }
  if (row.kind === 'line') {
    const l = row.line;
    return (
      <div class={`change-row change-line ${l.kind}`} style={{ ...style, ...indent }}>
        <span class="line-no">{l.old ?? ''}</span>
        <span class="line-no">{l.new ?? ''}</span>
        <span class="line-sign">{l.kind === 'added' ? '+' : l.kind === 'deleted' ? '−' : ''}</span>
        <span class="line-text">{l.text}</span>
      </div>
    );
  }
  const f: ChangedFile = row.file;
  const letter = changeLetter(f);
  const isOpen = unfolded.has(row.key);
  return (
    <div
      class={`change-row change-file${f.path === current ? ' current' : ''}`}
      style={{ ...style, ...indent }}
      aria-current={f.path === current ? 'true' : undefined}
    >
      <button
        class="change-unfold"
        onClick={() => unfold(row.key, row.group, f.path)}
        aria-expanded={isOpen}
        title={`${f.origPath ? `${f.origPath} → ` : ''}${f.path}${f.uncommitted ? '\nNot committed yet' : ''}\nClick to ${isOpen ? 'fold' : 'unfold'} its diff here`}
      >
        <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'}`} />
        <span class={`change-letter kind-${letter}`}>{letter}</span>
        <span class="change-name">{row.name}</span>
        {f.uncommitted && (
          <span class="change-uncommitted" title="Not committed yet">
            uncommitted
          </span>
        )}
        <Counts added={f.added} deleted={f.deleted} binary={f.binary} />
      </button>
      <button class="change-action icon" onClick={() => expand({ group: row.group, path: f.path })} title="Expand: the whole file's diff" aria-label="Expand">
        <i class="codicon codicon-screen-full" />
      </button>
    </div>
  );
}
