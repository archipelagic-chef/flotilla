import { useMemo, useState } from 'preact/hooks';
import type { ChangedFile, TicketView } from '../ticketProtocol';
import { ActionButton, send } from './actions';
import { changeLetter, changeRows, rowWindow, type ChangeRow } from './changeTree';

const ROW = 22;
const MAX_HEIGHT = 440;

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
 * What the ticket's work changes compared with main (BL-171): its files as a tree that folds by folder, each with its
 * lines added and deleted. A file opens its diff; Open All Changes opens them all in the multi-file diff editor.
 */
export function Changes({ ticket }: { ticket: TicketView }) {
  const change = ticket.changes;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const rows = useMemo(() => (change ? changeRows(change, folded) : []), [change, folded]);
  const toggle = (key: string) => {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    setFolded(next);
  };
  const height = Math.min(rows.length * ROW, MAX_HEIGHT);
  const { start, end } = rowWindow(rows.length, scrollTop, height, ROW);
  return (
    <section class="block changes">
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
          <ActionButton class="text-button" message={{ type: 'openAllChanges' }} working="Opening…" title="Open them all in the multi-file diff editor">
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
            <div class="change-rows" style={{ height: `${height}px` }} onScroll={(e) => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}>
              <div style={{ height: `${rows.length * ROW}px`, position: 'relative' }}>
                {rows.slice(start, end).map((r, i) => (
                  <Row key={r.key} row={r} top={(start + i) * ROW} ticket={ticket} toggle={toggle} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Row({ row, top, ticket, toggle }: { row: ChangeRow; top: number; ticket: TicketView; toggle: (key: string) => void }) {
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
  const f: ChangedFile = row.file;
  const letter = changeLetter(f);
  return (
    <button
      class="change-row change-file"
      style={{ ...style, ...indent }}
      onClick={() => send({ type: 'openChange', group: row.group, path: f.path })}
      title={`${f.origPath ? `${f.origPath} → ` : ''}${f.path}${f.uncommitted ? '\nNot committed yet' : ''}\nClick to open its diff`}
    >
      <span class={`change-letter kind-${letter}`}>{letter}</span>
      <span class="change-name">{row.name}</span>
      {f.uncommitted && (
        <span class="change-uncommitted" title="Not committed yet">
          uncommitted
        </span>
      )}
      <Counts added={f.added} deleted={f.deleted} binary={f.binary} />
    </button>
  );
}
