import { useEffect, useRef, useState } from 'preact/hooks';
import { branchMatches } from '../../features/backlog/backlog';
import type { BacklogItem, BacklogStatus, WorkstreamView } from '../protocol';
import { send } from './api';

const LANES: Array<{ status: BacklogStatus; title: string; icon: string }> = [
  { status: 'todo', title: 'To Do', icon: 'circle-large-outline' },
  { status: 'doing', title: 'In Progress', icon: 'circle-large-filled' },
  { status: 'done', title: 'Done', icon: 'pass-filled' },
];

const DRAG_TYPE = 'application/x-flotilla-backlog';

interface Props {
  items: BacklogItem[] | undefined;
  workstreams: WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  /** The host asked for the new-item box (Add Backlog Item… command). */
  adding: boolean;
  setAdding(adding: boolean): void;
  openWorktree(key: string): void;
}

/**
 * The backlog: items in priority order in three lanes. Drag to reprioritize or to move between lanes; Start creates
 * (or shows) the item's worktree. Local items live in the repository's git dir, shared by all its worktrees.
 */
export function BacklogView({ items, workstreams, colors, adding, setAdding, openWorktree }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [dropAt, setDropAt] = useState<{ status: BacklogStatus; before?: string }>();
  const worktreeOf = (item: BacklogItem) => workstreams.find((w) => !w.isMain && branchMatches(item, w.branch));

  const drop = (e: DragEvent, status: BacklogStatus, before?: string) => {
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    setDropAt(undefined);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (id !== before) send({ type: 'backlog', op: 'move', id, status, before });
  };
  const dragOver = (e: DragEvent, status: BacklogStatus, before?: string) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt?.status !== status || dropAt.before !== before) setDropAt({ status, before });
  };

  return (
    <div class="backlog" onDragEnd={() => setDropAt(undefined)}>
      <div class="tool-title backlog-title">
        <span>Backlog</span>
        <button class="icon" aria-label="Add Item" onClick={() => setAdding(true)}>
          <i class="codicon codicon-add" />
        </button>
      </div>
      {adding && <NewItem onDone={() => setAdding(false)} />}
      {!items && <div class="empty">Loading the backlog…</div>}
      {items?.length === 0 && !adding && (
        <div class="empty">
          Nothing in the backlog yet.{' '}
          <button class="link" onClick={() => setAdding(true)}>
            Add an item
          </button>
        </div>
      )}
      {items &&
        items.length > 0 &&
        LANES.map((lane) => {
          const laneItems = items.filter((i) => i.status === lane.status);
          const open = lane.status !== 'done' || doneOpen;
          return (
            <div key={lane.status} class={`group lane${dropAt?.status === lane.status && !dropAt.before ? ' drop-end' : ''}`}>
              <div
                class="row group-head"
                onClick={lane.status === 'done' ? () => setDoneOpen(!doneOpen) : undefined}
                onDragOver={(e) => dragOver(e, lane.status)}
                onDrop={(e) => drop(e, lane.status)}
              >
                <span class="name">{lane.title}</span>
                {lane.status === 'done' && (
                  <i class={`codicon codicon-chevron-${doneOpen ? 'down' : 'right'} lane-chev`} aria-label={doneOpen ? 'Hide done items' : 'Show done items'} />
                )}
                <span class="badge">{laneItems.length}</span>
              </div>
              {open && (
                <div class="lane-body" onDragOver={(e) => dragOver(e, lane.status)} onDrop={(e) => drop(e, lane.status)}>
                  {laneItems.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      icon={lane.icon}
                      worktree={worktreeOf(item)}
                      color={(ws) => colors.get(ws.key)}
                      renaming={renaming === item.id}
                      setRenaming={(on) => setRenaming(on ? item.id : undefined)}
                      dropBefore={dropAt?.before === item.id}
                      onDragOver={(e) => dragOver(e, lane.status, item.id)}
                      onDrop={(e) => drop(e, lane.status, item.id)}
                      openWorktree={openWorktree}
                    />
                  ))}
                  {!laneItems.length && <div class="row group-empty">{lane.status === 'doing' ? 'Start an item to work on it' : 'Nothing here'}</div>}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

function NewItem({ onDone }: { onDone(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  useEffect(() => input.current?.focus(), []);
  return (
    <div class="backlog-new">
      <input
        ref={input}
        value={title}
        placeholder="What needs doing? Enter adds it"
        aria-label="New backlog item"
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim()) {
            send({ type: 'backlog', op: 'add', title });
            // The box stays for the next item.
            setTitle('');
          } else if (e.key === 'Escape') onDone();
        }}
        onBlur={() => !title.trim() && onDone()}
      />
    </div>
  );
}

interface RowProps {
  item: BacklogItem;
  icon: string;
  worktree: WorkstreamView | undefined;
  color(ws: WorkstreamView): string | undefined;
  renaming: boolean;
  setRenaming(on: boolean): void;
  dropBefore: boolean;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
  openWorktree(key: string): void;
}

function ItemRow({ item, icon, worktree, color, renaming, setRenaming, dropBefore, onDragOver, onDrop, openWorktree }: RowProps) {
  const done = item.status === 'done';
  const setStatus = (status: BacklogStatus) => send({ type: 'backlog', op: 'update', id: item.id, status });
  return (
    <div
      class={`row backlog-item st-${item.status}${dropBefore ? ' drop-before' : ''}`}
      tabIndex={0}
      draggable={!renaming}
      data-tip={item.notes ? `${item.id} · ${item.title}\n\n${item.notes}` : undefined}
      onDragStart={(e) => {
        e.dataTransfer?.setData(DRAG_TYPE, item.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDblClick={() => setRenaming(true)}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === 'F2' || e.key === 'Enter') setRenaming(true);
        else if (e.key === 'Delete') send({ type: 'backlog', op: 'delete', id: item.id });
        else return;
        e.preventDefault();
      }}
    >
      <button
        class={`icon status-toggle`}
        aria-label={done ? 'Reopen' : 'Mark Done'}
        onClick={(e) => {
          e.stopPropagation();
          setStatus(done ? 'todo' : 'done');
        }}
      >
        <i class={`codicon codicon-${icon}`} />
      </button>
      <span class="item-id">{item.id}</span>
      {renaming ? (
        <RenameBox item={item} onDone={() => setRenaming(false)} />
      ) : (
        <span class="name">{item.title}</span>
      )}
      {worktree && (
        <button
          class="ws-chip"
          style={{ '--ws-color': color(worktree) }}
          data-tip-ws={worktree.key}
          data-tip-hint="Click to open its tab"
          onClick={(e) => {
            e.stopPropagation();
            openWorktree(worktree.key);
          }}
        >
          {worktree.label}
        </button>
      )}
      {!renaming && (
        <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
          {!done && !worktree && (
            <button class="icon" aria-label="Start Work (Create Its Worktree)" onClick={() => send({ type: 'backlog', op: 'start', id: item.id })}>
              <i class="codicon codicon-play" />
            </button>
          )}
          <button class="icon" aria-label="Rename" onClick={() => setRenaming(true)}>
            <i class="codicon codicon-edit" />
          </button>
          <button class="icon" aria-label="Delete…" onClick={() => send({ type: 'backlog', op: 'delete', id: item.id })}>
            <i class="codicon codicon-trash" />
          </button>
        </span>
      )}
    </div>
  );
}

function RenameBox({ item, onDone }: { item: BacklogItem; onDone(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(item.title);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const save = () => {
    if (title.trim() && title.trim() !== item.title) send({ type: 'backlog', op: 'update', id: item.id, title });
    onDone();
  };
  return (
    <input
      ref={input}
      class="rename"
      value={title}
      aria-label={`Rename ${item.id}`}
      onClick={(e) => e.stopPropagation()}
      onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') save();
        else if (e.key === 'Escape') onDone();
      }}
      onBlur={save}
    />
  );
}
