import { useEffect, useRef, useState } from 'preact/hooks';
import { branchMatches } from '../../features/backlog/backlog';
import type { BacklogItemView as BacklogItem, BacklogProblem, BacklogStatus, WorkstreamView } from '../protocol';
import { send } from './api';
import { PriorityPicker } from './priority';
import './priority.css';

const LANES: Array<{ status: BacklogStatus; title: string; icon: string }> = [
  { status: 'todo', title: 'To Do', icon: 'circle-large-outline' },
  { status: 'doing', title: 'In Progress', icon: 'circle-large-filled' },
  { status: 'review', title: 'In Review', icon: 'eye' },
  { status: 'done', title: 'Done', icon: 'pass-filled' },
];

const EMPTY_LANE: Record<BacklogStatus, string> = {
  todo: 'Nothing here',
  doing: 'Start an item to work on it',
  review: 'Move items here when their work waits for a review',
  done: 'Nothing here',
};

const DRAG_TYPE = 'application/x-flotilla-backlog';

interface Props {
  items: BacklogItem[] | undefined;
  /** Integrations whose issues don't load. */
  problems: BacklogProblem[];
  /** How many integrations are connected. */
  integrations: number;
  workstreams: WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  openWorktree(key: string): void;
}

/**
 * The backlog: items in priority order in three lanes. Drag to reprioritize or to move between lanes; Start creates
 * (or shows) the item's worktree. Local items live in the repository's git dir, shared by all its worktrees.
 */
export function BacklogView({ items, problems, integrations, workstreams, colors, openWorktree }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [dropAt, setDropAt] = useState<{ status: BacklogStatus; before?: string }>();
  const worktreesOf = (item: BacklogItem) => workstreams.filter((w) => !w.isMain && branchMatches(item, w.branch));

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
        <span class="title-actions">
          {integrations > 0 && (
            <button class="icon" aria-label="Refresh Issues" onClick={() => send({ type: 'backlog', op: 'refresh' })}>
              <i class="codicon codicon-refresh" />
            </button>
          )}
          <button class="icon" aria-label="Integrations (Jira, GitHub Issues)…" onClick={() => send({ type: 'backlog', op: 'integrations' })}>
            <i class="codicon codicon-plug" />
          </button>
          <button class="icon" aria-label="Add Item" onClick={() => send({ type: 'backlog', op: 'new' })}>
            <i class="codicon codicon-add" />
          </button>
        </span>
      </div>
      {problems.map((p) => (
        <button key={p.label} class="backlog-problem" onClick={() => send({ type: 'backlog', op: 'integrations' })}>
          <i class="codicon codicon-warning" />
          <span>
            <strong>{p.label}</strong>: {p.error}
          </span>
        </button>
      ))}
      {!items && <div class="empty">Loading the backlog…</div>}
      {items?.length === 0 && (
        <div class="empty">
          Nothing in the backlog yet.{' '}
          <button class="link" onClick={() => send({ type: 'backlog', op: 'new' })}>
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
                      worktrees={worktreesOf(item)}
                      color={(ws) => colors.get(ws.key)}
                      renaming={renaming === item.id}
                      setRenaming={(on) => setRenaming(on ? item.id : undefined)}
                      dropBefore={dropAt?.before === item.id}
                      onDragOver={(e) => dragOver(e, lane.status, item.id)}
                      onDrop={(e) => drop(e, lane.status, item.id)}
                      openWorktree={openWorktree}
                    />
                  ))}
                  {!laneItems.length && <div class="row group-empty">{EMPTY_LANE[lane.status]}</div>}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

interface RowProps {
  item: BacklogItem;
  icon: string;
  /** The worktrees working on it: one, or several for an epic. */
  worktrees: WorkstreamView[];
  color(ws: WorkstreamView): string | undefined;
  renaming: boolean;
  setRenaming(on: boolean): void;
  dropBefore: boolean;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
  openWorktree(key: string): void;
}

/** The agent's state on a worktree chip, as on the worktree tabs. */
const AGENT_DOT: Record<string, string | undefined> = { 'waiting-for-input': 'waiting', error: 'error', working: 'working', done: 'done' };

function ItemRow({ item, icon, worktrees, color, renaming, setRenaming, dropBefore, onDragOver, onDrop, openWorktree }: RowProps) {
  const done = item.status === 'done';
  // Issues from integrations are ordered, renamed and closed in their tracker.
  const remote = item.source;
  const worktree = worktrees[0];
  const setStatus = (status: BacklogStatus) => send({ type: 'backlog', op: 'update', id: item.id, status });
  return (
    <div
      class={`row backlog-item st-${item.status}${dropBefore ? ' drop-before' : ''}`}
      tabIndex={0}
      draggable={!renaming && !remote}
      onDragStart={(e) => {
        e.dataTransfer?.setData(DRAG_TYPE, item.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => !renaming && send({ type: 'backlog', op: 'open', id: item.id })}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === 'F2' && !remote) setRenaming(true);
        else if (e.key === 'Enter') send({ type: 'backlog', op: 'open', id: item.id });
        else if (e.key === 'Delete' && !remote) send({ type: 'backlog', op: 'delete', id: item.id });
        else return;
        e.preventDefault();
      }}
    >
      {remote ? (
        <span class="status-toggle source-icon" data-tip={`${remote.label} · ${remote.statusName}`}>
          <i class={`codicon codicon-${remote.kind === 'github' ? 'github' : 'issues'}`} />
        </span>
      ) : (
        <button
          class="icon status-toggle"
          aria-label={done ? 'Reopen' : 'Mark Done'}
          onClick={(e) => {
            e.stopPropagation();
            setStatus(done ? 'todo' : 'done');
          }}
        >
          <i class={`codicon codicon-${icon}`} />
        </button>
      )}
      <PriorityPicker
        compact
        value={item.priority}
        onChange={remote ? undefined : (priority) => send({ type: 'backlog', op: 'update', id: item.id, priority })}
      />
      <span class="item-id">{item.id}</span>
      {renaming ? (
        <RenameBox item={item} onDone={() => setRenaming(false)} />
      ) : (
        <>
          <span class="name">{item.title}</span>
          {item.summary && <span class="desc">{item.summary}</span>}
        </>
      )}
      {!renaming && item.activity > 0 && (
        <span class="activity-count" aria-label={`${item.activity} activity entries`}>
          <i class="codicon codicon-comment" />
          {item.activity}
        </span>
      )}
      {!renaming && item.linked && (
        // One small badge (the title needs the room); the hover lists the issues, a click opens the first.
        <a
          class="link-badge"
          href={item.linked[0].url}
          data-tip={item.linked.map((l) => `${l.id}${l.statusName ? ` · ${l.statusName}` : ''}  ${l.title}`).join('\n')}
          data-tip-hint={`Click to open ${item.linked[0].id} in ${item.linked[0].kind === 'jira' ? 'Jira' : 'GitHub'}`}
          onClick={(e) => e.stopPropagation()}
        >
          <i class={`codicon codicon-${item.linked[0].kind === 'github' ? 'github' : 'issues'}`} />
          {item.linked.length > 1 && item.linked.length}
        </a>
      )}
      {worktrees.slice(0, 2).map((ws) => {
        const dot = AGENT_DOT[ws.attention];
        return (
          <button
            key={ws.key}
            class="ws-chip"
            style={{ '--ws-color': color(ws) }}
            data-tip-ws={ws.key}
            data-tip-hint="Click to open its tab"
            onClick={(e) => {
              e.stopPropagation();
              openWorktree(ws.key);
            }}
          >
            {dot && <span class={`dot ${dot}`} />}
            {ws.label}
          </button>
        );
      })}
      {worktrees.length > 2 && (
        <span class="ws-more" data-tip={worktrees.slice(2).map((w) => w.branch).join('\n')}>
          +{worktrees.length - 2}
        </span>
      )}
      {!renaming && (
        <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
          {!done && (
            <button
              class="icon"
              aria-label={worktree ? 'Start an Agent on It (in Its Worktree)' : 'Start an Agent on It (Creates Its Worktree)'}
              onClick={() => send({ type: 'backlog', op: 'start', id: item.id })}
            >
              <i class="codicon codicon-play" />
            </button>
          )}
          {remote ? (
            <a class="icon" href={remote.url} aria-label={`Open in ${remote.label}`}>
              <i class="codicon codicon-link-external" />
            </a>
          ) : (
            <>
              <button class="icon" aria-label="Write It with Claude" onClick={() => send({ type: 'backlog', op: 'ai', id: item.id })}>
                <i class="codicon codicon-sparkle" />
              </button>
              <button class="icon" aria-label="Link to an Issue (Jira, GitHub)…" onClick={() => send({ type: 'backlog', op: 'link', id: item.id })}>
                <i class="codicon codicon-link" />
              </button>
              <button class="icon" aria-label="Rename" onClick={() => setRenaming(true)}>
                <i class="codicon codicon-edit" />
              </button>
              <button class="icon" aria-label="Delete…" onClick={() => send({ type: 'backlog', op: 'delete', id: item.id })}>
                <i class="codicon codicon-trash" />
              </button>
            </>
          )}
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
