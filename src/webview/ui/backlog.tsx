import { useState } from 'preact/hooks';
import { agentCountLabel } from './agentCount';
import { branchMatches, laneOf, type BacklogLane } from '../../features/backlog/backlog';
import { cardAgents } from '../../features/backlog/cardAgents';
import { hasActiveAgent } from '../../features/backlog/activeAgent';
import { turnOf } from '../../features/backlog/turn';
import type { BacklogItemView as BacklogItem, BacklogProblem, BacklogStatus, WorkstreamView, AutopilotState, MergeQueueView } from '../protocol';
import { send } from './api';
import { BusyButton } from './backlogBusy';
import './priority.css';
import { TitleBar } from './titleBar';
import { AutopilotBar } from './autopilotBar';
import { NeedsYou } from './needsYou';
import { DRAG_TYPE, ItemRow } from './card';

const LANES: Array<{ lane: BacklogLane; title: string; icon: string }> = [
  { lane: 'todo', title: 'To Do', icon: 'circle-large-outline' },
  { lane: 'doing', title: 'In Progress', icon: 'circle-large-filled' },
  { lane: 'review', title: 'In Review', icon: 'eye' },
  { lane: 'ready', title: 'Ready to Merge', icon: 'git-merge' },
  { lane: 'done', title: 'Done', icon: 'pass-filled' },
];

const EMPTY_LANE: Record<BacklogLane, string> = {
  todo: 'Nothing here',
  doing: 'Start an item to work on it',
  review: 'Move items here when their work waits for a review',
  ready: 'Approved work waits here to be merged',
  done: 'Nothing here',
};

/** A ticket dragged within the merge queue bar (BL-144): the lanes don't take it. */
const QUEUE_DRAG_TYPE = 'application/x-flotilla-merge-queue';

export interface Props {
  items: BacklogItem[] | undefined;
  /** Integrations whose issues don't load. */
  problems: BacklogProblem[];
  /** How many integrations are connected. */
  integrations: number;
  autopilot?: AutopilotState;
  mergeQueue?: MergeQueueView;
  workstreams: WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  /** The board shows only the tickets an agent works on (kept in the view's state). */
  workingOnly: boolean;
  setWorkingOnly(on: boolean): void;
  openWorktree(key: string): void;
}

/**
 * The backlog: items in priority order in three lanes. Drag to reprioritize or to move between lanes; Start creates
 * (or shows) the item's worktree. Local items live in the repository's git dir, shared by all its worktrees.
 */
export function BacklogView({ items, problems, integrations, autopilot, mergeQueue, workstreams, colors, workingOnly, setWorkingOnly, openWorktree }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  // The Review lane shows only the tickets whose turn is the user's.
  const [mineOnly, setMineOnly] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [dropAt, setDropAt] = useState<{ status: BacklogStatus; before?: string }>();
  const worktreesOf = (item: BacklogItem) => workstreams.filter((w) => !w.isMain && branchMatches(item, w.branch));
  // Agents' proposals wait above the lanes until they're accepted.
  const proposed = workingOnly ? [] : (items ?? []).filter((i) => i.proposed);
  const agentCount = agentCountLabel(autopilot);
  const working = workingOnly ? (items ?? []).filter((i) => hasActiveAgent(i, worktreesOf(i))).length : 0;
  // Every chat, wherever it runs: an agent's first line names its ticket (BL-96).
  const chats = workstreams.flatMap((w) => w.chats);
  const agentsOf = (item: BacklogItem) => (item.source ? [] : cardAgents(item, chats));

  // Ready to Merge is no drop target: an item gets there by its review's approval (in its ticket).
  const drop = (e: DragEvent, lane: BacklogLane, before?: string) => {
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    setDropAt(undefined);
    if (!id || lane === 'ready') return;
    e.preventDefault();
    e.stopPropagation();
    if (id !== before) send({ type: 'backlog', op: 'move', id, status: lane, before });
  };
  const dragOver = (e: DragEvent, lane: BacklogLane, before?: string) => {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE) || lane === 'ready') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt?.status !== lane || dropAt.before !== before) setDropAt({ status: lane, before });
  };

  return (
    <div class="backlog" onDragEnd={() => setDropAt(undefined)}>
      <TitleBar integrations={integrations} autopilot={autopilot} workingOnly={workingOnly} setWorkingOnly={setWorkingOnly} />
      {agentCount && (
        <button
          class={`agent-count${workingOnly ? ' on' : ''}`}
          onClick={() => setWorkingOnly(!workingOnly)}
          title={`${agentCount}: ${workingOnly ? 'show all tickets' : 'show only tickets being worked on'}`}
        >
          <i class="codicon codicon-hubot" />
          <span>{agentCount}</span>
        </button>
      )}
      {autopilot?.enabled && <AutopilotBar autopilot={autopilot} />}
      {mergeQueue && mergeQueue.entries.length > 0 && <MergeQueueBar queue={mergeQueue} />}
      {workingOnly && items && items.length > 0 && (
        <button class="working-bar" onClick={() => setWorkingOnly(false)} title="Click to show every ticket">
          <i class="codicon codicon-filter-filled" />
          <span>
            {working === 0 ? 'No ticket is being worked on' : `${working} ${working === 1 ? 'ticket' : 'tickets'} being worked on`} · {items.filter((i) => !i.proposed).length - working} hidden.{' '}
            <span class="link">Show all</span>
          </span>
        </button>
      )}
      {problems.map((p) => (
        <button key={p.label} class="backlog-problem" onClick={() => send({ type: 'backlog', op: 'integrations' })}>
          <i class="codicon codicon-warning" />
          <span>
            <strong>{p.label}</strong>: {p.error}
          </span>
        </button>
      ))}
      <NeedsYou items={items ?? []} />
      {!items && <div class="empty">Loading the backlog…</div>}
      {items?.length === 0 && (
        <div class="empty">
          Nothing in the backlog yet.{' '}
          <button class="link" onClick={() => send({ type: 'backlog', op: 'new' })}>
            Add an item
          </button>
        </div>
      )}
      {proposed.length > 0 && (
        <div class="group lane proposed-lane">
          <div class="row group-head">
            <span class="name">Proposed by Agents</span>
            <BusyButton class="icon" aria-label="Accept All" message={{ type: 'backlog', op: 'acceptAll' }} icon="check-all" />
            <span class="badge">{proposed.length}</span>
          </div>
          <div class="lane-body">
            {proposed.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                icon="lightbulb"
                worktrees={worktreesOf(item)}
                agents={agentsOf(item)}
                color={(ws) => colors.get(ws.key)}
                renaming={renaming === item.id}
                setRenaming={(on) => setRenaming(on ? item.id : undefined)}
                dropBefore={false}
                onDragOver={() => undefined}
                onDrop={() => undefined}
                openWorktree={openWorktree}
              />
            ))}
          </div>
        </div>
      )}
      {items &&
        items.length > 0 &&
        LANES.map((lane) => {
          const filtered = lane.lane === 'review' && mineOnly;
          const laneItems = items.filter(
            (i) => laneOf(i) === lane.lane && !i.proposed && (!filtered || (!i.source && turnOf(i)?.mine)) && (!workingOnly || hasActiveAgent(i, worktreesOf(i))),
          );
          const open = lane.lane !== 'done' || doneOpen;
          return (
            <div key={lane.lane} class={`group lane${dropAt?.status === lane.lane && !dropAt.before ? ' drop-end' : ''}`}>
              <div
                class="row group-head"
                onClick={lane.lane === 'done' ? () => setDoneOpen(!doneOpen) : undefined}
                onDragOver={(e) => dragOver(e, lane.lane)}
                onDrop={(e) => drop(e, lane.lane)}
              >
                <span class="name">{lane.title}</span>
                {lane.lane === 'done' && (
                  <i class={`codicon codicon-chevron-${doneOpen ? 'down' : 'right'} lane-chev`} aria-label={doneOpen ? 'Hide done items' : 'Show done items'} />
                )}
                {lane.lane === 'review' && (
                  <button
                    class={`icon lane-filter${mineOnly ? ' on' : ''}`}
                    aria-pressed={mineOnly}
                    aria-label={mineOnly ? 'Waiting for me: click to show every ticket in review' : 'Show only what waits for me'}
                    onClick={() => setMineOnly(!mineOnly)}
                  >
                    <i class={`codicon codicon-${mineOnly ? 'filter-filled' : 'filter'}`} />
                  </button>
                )}
                <span class="badge">{laneItems.length}</span>
              </div>
              {open && (
                <div class="lane-body" onDragOver={(e) => dragOver(e, lane.lane)} onDrop={(e) => drop(e, lane.lane)}>
                  {laneItems.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      icon={lane.icon}
                      worktrees={worktreesOf(item)}
                      agents={agentsOf(item)}
                      color={(ws) => colors.get(ws.key)}
                      renaming={renaming === item.id}
                      setRenaming={(on) => setRenaming(on ? item.id : undefined)}
                      queuedBehind={(mergeQueue?.entries.findIndex((e) => e.id === item.id) ?? -1) > 0}
                      dropBefore={dropAt?.before === item.id}
                      onDragOver={(e) => dragOver(e, lane.lane, item.id)}
                      onDrop={(e) => drop(e, lane.lane, item.id)}
                      openWorktree={openWorktree}
                    />
                  ))}
                  {!laneItems.length && <div class="row group-empty">{workingOnly ? 'No agent works on these' : filtered ? 'Nothing in review waits for you' : EMPTY_LANE[lane.lane]}</div>}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

/**
 * The merge queue (BL-140), above the board: the tickets waiting to land, first to land first, each opening its ticket
 * (one that conflicts with the ones ahead of it is marked), what the queue does now, and Land All (Merge All Ready).
 * Its tickets are dragged to change the order they land in (BL-144).
 */
function MergeQueueBar({ queue }: { queue: MergeQueueView }) {
  // Where a dragged ticket would go: before this one, or at the end (null).
  const [dropBefore, setDropBefore] = useState<string | null>();
  const ids = queue.entries.map((e) => e.id);
  const dragOver = (e: DragEvent, before: string | null) => {
    if (!e.dataTransfer?.types.includes(QUEUE_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropBefore(before);
  };
  const drop = (e: DragEvent) => {
    const id = e.dataTransfer?.getData(QUEUE_DRAG_TYPE);
    const before = dropBefore;
    setDropBefore(undefined);
    if (!id || before === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const order = moveBefore(ids, id, before);
    if (order.join() !== ids.join()) send({ type: 'backlog', op: 'queueOrder', ids: order });
  };
  return (
    <div class="merge-queue-bar">
      <i class="codicon codicon-git-merge" />
      <span>
        <strong>Merge queue</strong>
        {queue.working ? ` · ${capitalizeFirst(queue.working)}` : ''}
        {' · '}
        <span class="queue-entries" onDragOver={(e) => dragOver(e, null)} onDragLeave={() => setDropBefore(undefined)} onDrop={drop}>
          {queue.entries.map((e, i) => (
            <span key={e.id} onDragOver={(ev) => dragOver(ev, e.id)}>
              {i > 0 && ', '}
              <a
                href="#"
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer?.setData(QUEUE_DRAG_TYPE, e.id);
                  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDropBefore(undefined)}
                class={[e.state === 'conflicts' ? 'conflicts' : '', dropBefore === e.id ? 'drop-before' : ''].filter(Boolean).join(' ') || undefined}
                title={e.state === 'conflicts' ? `${e.id} conflicts with the tickets ahead of it: it waits` : e.state === 'clean' ? `${e.id} merges cleanly onto main and the tickets ahead` : `${e.id}: the merge train is being built`}
                onClick={(ev) => {
                  ev.preventDefault();
                  send({ type: 'backlog', op: 'open', id: e.id });
                }}
              >
                {e.id}
                {e.state === 'conflicts' && ' (conflicts)'}
              </a>
            </span>
          ))}
          {dropBefore === null && <span class="drop-end" />}
        </span>
      </span>
      <button class="land-all" disabled={!!queue.working} onClick={() => send({ type: 'backlog', op: 'landAll' })} title="Merge All Ready: lands the queue's tickets in order, each after its checks">
        Land All
      </button>
    </div>
  );
}

/** The ids with one moved before another (null: to the end). */
function moveBefore(ids: readonly string[], id: string, before: string | null): string[] {
  if (id === before) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  return at < 0 ? [...ids] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
