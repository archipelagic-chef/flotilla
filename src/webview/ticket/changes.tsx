import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChangedFile, FileDiff, TicketHostMessage, TicketView } from '../ticketProtocol';
import { ActionButton, send } from './actions';
import './changes.css';
import { changeLetter, changeRows, rowWindow, withDiffs, type ChangeRow, type DiffRow } from './changeTree';
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
  const change = ticket.changes;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  /** The file whose diff was opened last (marked), and one to scroll to once its row is there. */
  const [current, setCurrent] = useState<string>();
  const [reveal, setReveal] = useState<{ path?: string }>();
  /** The files whose diffs are unfolded inline (their rows' keys), and the diffs read (until the change is new). */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [diffs, setDiffs] = useState<ReadonlyMap<string, FileDiff>>(new Map());
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
  useEffect(() => {
    setDiffs(new Map());
    if (!change) return;
    for (const key of unfolded) {
      const [g, ...rest] = key.split(':');
      const path = rest.join(':');
      if (change.groups[Number(g)]?.files.some((f) => f.path === path)) read(key, Number(g), path);
    }
  }, [change]);
  const rows = useMemo(() => (change ? withDiffs(changeRows(change, folded), unfolded, diffs) : []), [change, folded, unfolded, diffs]);
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
  const open = (group: number, path: string) => {
    setCurrent(path);
    send({ type: 'openChange', group, path });
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
          <ActionButton class="text-button" message={{ type: 'openAllChanges' }} working="Opening…" title="Open them all in the multi-file diff editor, beside the ticket">
            <i class="codicon codicon-diff-multiple" /> Open All Changes
          </ActionButton>
        )}
      </div>
      <div class="work">
        {!change ? (
          <div class="work-empty muted">Reading the changes…</div>
        ) : !change.files ? (
          <div class="work-empty muted">No changes yet</div>
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

function Row({
  row,
  top,
  ticket,
  toggle,
  unfold,
  unfolded,
  open,
  expand,
  current,
}: {
  row: ChangeRow | DiffRow;
  top: number;
  ticket: TicketView;
  toggle: (key: string) => void;
  unfold: (key: string, group: number, path: string) => void;
  unfolded: ReadonlySet<string>;
  open: (group: number, path: string) => void;
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
      <button class="change-row" style={{ ...style, ...indent }} onClick={() => toggle(row.key)} aria-expanded={row.open} title={`${row.count} file${row.count === 1 ? '' : 's'}`}>
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
        <button class="change-action" onClick={() => expand({ group: row.group, path: row.path, line: row.line })} title={`Expand: the whole file's diff, at line ${row.line}`}>
          <i class="codicon codicon-screen-full" /> Expand
        </button>
      </div>
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
    <div class={`change-row change-file${f.path === current ? ' current' : ''}`} style={{ ...style, ...indent }} aria-current={f.path === current ? 'true' : undefined}>
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
