import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import type {
  ChangedFile,
  FileDiff,
  TicketView,
} from '../ticketProtocol';
import { send } from './actions';
import { changeDiffReplies } from './changes';
import {
  changeLetter,
  changeRows,
  fullRows,
  rowWindow,
} from './changeTree';
import './diffView.css';
import { LineText } from './lineText';

const ROW = 20;

/** The file a full view shows (group: its index in the ticket's change), and the line to open it at. */
export interface FullAt {
  group: number;
  path: string;
  line?: number;
}

let nextDiff = 1_000_000;

/**
 * A file of the ticket's Changes, expanded to the ticket's whole tab (BL-171): its whole diff, unchanged stretches
 * folded. The bar at its top keeps it the ticket's: its id and title, Changes, the file, with Back to the ticket where
 * it was (Escape too), the files before and after it, and Open in Diff Editor (VS Code's, beside the ticket). Its
 * switch goes through the ticket By commit (BL-213): the file as the commit picked in the sidebar changed it.
 */
export function DiffView({
  ticket,
  at,
  back,
  go,
  byCommit,
  mode,
}: {
  ticket: TicketView;
  at: FullAt;
  back: () => void;
  go: (at: FullAt) => void;
  byCommit?: { hash?: string };
  mode: (commits: boolean) => void;
}) {
  const change = ticket.changes;
  const group = change?.groups[at.group];
  const file = group?.files.find((f) => f.path === at.path);
  // Oldest first, as the sidebar steps through them.
  const commits = useMemo(() => [...ticket.commits].reverse(), [ticket.commits]);
  const commitAt = byCommit?.hash ? commits.findIndex((c) => c.hash === byCommit.hash) : -1;
  const commit = commits[commitAt] as (typeof commits)[number] | undefined;
  /** The file as the commit changed it (its counts), with its diff; none when the commit doesn't change it. */
  const [commitFile, setCommitFile] = useState<ChangedFile>();
  const hash = byCommit ? (byCommit.hash ?? null) : undefined;
  /** The files in the order Changes lists them, for Previous and Next. */
  const order = useMemo(
    () => (change ? changeRows(change, new Set()).flatMap((r) => (r.kind === 'file' ? [{ group: r.group, path: r.file.path }] : [])) : []),
    [change],
  );
  const index = order.findIndex((o) => o.group === at.group && o.path === at.path);
  const [diff, setDiff] = useState<FileDiff>();
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const body = useRef<HTMLDivElement>(null);
  // Read again for another file, another commit, and when the change is new.
  useEffect(() => {
    if (!file || hash === null) return;
    const requestId = nextDiff++;
    changeDiffReplies.set(requestId, (d, f) => {
      setDiff(d);
      setCommitFile(f);
    });
    send(
      hash === undefined
        ? { type: 'readChangeDiff', requestId, group: at.group, path: at.path, whole: true }
        : { type: 'readCommitDiff', requestId, group: at.group, path: at.path, hash },
    );
    return () => changeDiffReplies.delete(requestId);
  }, [at.group, at.path, change, hash]);
  useEffect(() => {
    setDiff(undefined);
    setCommitFile(undefined);
    setShown(new Set());
  }, [at.group, at.path, hash]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && back();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [back]);
  useLayoutEffect(() => {
    const measure = () => body.current && setHeight(body.current.clientHeight);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const lines = useMemo(() => (diff && 'hunks' in diff ? diff.hunks.flatMap((h) => h.lines) : []), [diff]);
  const rows = useMemo(() => fullRows(lines, shown), [lines, shown]);
  // Opened at a line (a hunk's Expand): scrolled to it once it's there.
  const opened = useRef<string>();
  useEffect(() => {
    const target = `${at.group}:${at.path}:${at.line ?? ''}`;
    if (!rows.length || opened.current === target || !body.current) return;
    opened.current = target;
    const i = at.line
      ? rows.findIndex((r) => r.kind === 'line' && (r.line.new ?? 0) >= at.line!)
      : rows.findIndex((r) => r.kind === 'line' && r.line.kind !== 'context');
    body.current.scrollTop = Math.max(0, i * ROW - height / 3);
  }, [rows, at]);
  const shownFile = byCommit ? commitFile : file;
  const { start, end } = rowWindow(rows.length, scrollTop, height, ROW);
  const step = (d: number) => {
    const next = order[index + d];
    if (next) go(next);
  };
  return (
    <div class="diff-view" role="region" aria-label={`${ticket.item.id}'s change to ${at.path}`}>
      <div class="diff-view-bar">
        <button class="primary diff-view-back" onClick={back} title={`Back to ${ticket.item.id}, where you were (Escape)`}>
          <i class="codicon codicon-arrow-left" /> Back to {ticket.item.id}
        </button>
        <div class="diff-view-mode" role="group" aria-label="What it shows">
          <button
            class={!byCommit ? 'on' : ''}
            aria-pressed={!byCommit}
            onClick={() => mode(false)}
            title="The ticket's whole change to this file (the sidebar shows its Changes)"
          >
            Whole change
          </button>
          <button
            class={byCommit ? 'on' : ''}
            aria-pressed={!!byCommit}
            onClick={() => mode(true)}
            title="This file in one commit at a time: step through them in the sidebar's Version Control"
          >
            By commit
          </button>
        </div>
        <nav class="diff-view-crumbs" aria-label="Where this is">
          <span class="crumb">
            <i class="codicon codicon-issues" /> <span class="ticket-id">{ticket.item.id}</span> <span class="crumb-title">{ticket.item.title}</span>
          </span>
          <i class="codicon codicon-chevron-right muted" />
          <span class="crumb">{byCommit ? (commit ? `Commit ${commitAt + 1} of ${commits.length}` : 'Commits') : 'Changes'}</span>
          <i class="codicon codicon-chevron-right muted" />
          <span class="crumb current">{at.path}</span>
        </nav>
      </div>
      <div class="diff-view-file">
        {shownFile && <span class={`change-letter kind-${changeLetter(shownFile)}`}>{changeLetter(shownFile)}</span>}
        <span class="diff-view-path" title={shownFile?.origPath ? `${shownFile.origPath} → ${shownFile.path}` : at.path}>
          {shownFile?.origPath ? `${shownFile.origPath} → ` : ''}
          {shownFile?.path ?? at.path}
        </span>
        {shownFile?.uncommitted && <span class="change-uncommitted">uncommitted</span>}
        {shownFile && (
          <span class="change-counts">
            <span class="added">+{shownFile.added}</span> <span class="deleted">−{shownFile.deleted}</span>
          </span>
        )}
        <span class="muted diff-view-compared" title={commit ? commit.subject : undefined}>
          {byCommit ? commit && `In ${commit.short}: ${commit.subject}` : group?.compared}
        </span>
        <span class="diff-view-actions">
          <button class="text-button" disabled={index <= 0} onClick={() => step(-1)} title="The file before it in Changes">
            <i class="codicon codicon-arrow-up" /> Previous
          </button>
          <span class="muted">
            {index + 1} of {order.length}
          </span>
          <button class="text-button" disabled={index < 0 || index >= order.length - 1} onClick={() => step(1)} title="The file after it in Changes">
            Next <i class="codicon codicon-arrow-down" />
          </button>
          <button
            class="text-button"
            onClick={() => send({ type: 'openChange', group: at.group, path: at.path })}
            title="In VS Code's diff editor, beside the ticket (its title bar and the status bar lead back)"
          >
            <i class="codicon codicon-split-horizontal" /> Open in Diff Editor
          </button>
        </span>
      </div>
      <div class="diff-view-body" ref={body} onScroll={(e) => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}>
        {!file ? (
          <div class="work-empty muted">It's no longer in the ticket's changes.</div>
        ) : byCommit && !byCommit.hash ? (
          <div class="work-empty muted">{'hash' in byCommit ? `${ticket.item.id} has no commits yet.` : 'Finding the commit to start at…'}</div>
        ) : !diff ? (
          <div class="work-empty muted">Reading its diff…</div>
        ) : 'note' in diff ? (
          <div class="work-empty muted">{diff.note}</div>
        ) : (
          <div style={{ height: `${rows.length * ROW}px`, position: 'relative' }}>
            {rows.slice(start, end).map((r, i) => {
              const style = { top: `${(start + i) * ROW}px`, height: `${ROW}px` };
              if (r.kind === 'gap')
                return (
                  <button key={r.key} class="full-row full-gap" style={style} onClick={() => setShown(new Set(shown).add(r.index))} title="Show them">
                    <i class="codicon codicon-unfold" /> {r.count} unchanged lines
                  </button>
                );
              const l = r.line;
              return (
                <div key={r.key} class={`full-row change-line ${l.kind}`} style={style}>
                  <span class="line-no">{l.old ?? ''}</span>
                  <span class="line-no">{l.new ?? ''}</span>
                  <span class="line-sign">{l.kind === 'added' ? '+' : l.kind === 'deleted' ? '−' : ''}</span>
                  <LineText line={l} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
