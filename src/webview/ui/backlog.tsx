import { useState } from 'preact/hooks';
import { agentCountLabel } from './agentCount';
import { branchMatches, laneOf, type BacklogLane } from '../../features/backlog/backlog';
import { cardAgents } from '../../features/backlog/cardAgents';
import { hasActiveAgent } from '../../features/backlog/activeAgent';
import { turnOf } from '../../features/backlog/turn';
import type { BacklogItemView as BacklogItem, BacklogProblem, BacklogStatus, WorkstreamView, AutopilotState, MergeQueueView } from '../protocol';
import { send } from './api';
import { act, BusyButton, useBusy } from './backlogBusy';
import { withMoves } from '../backlogActions';
import './priority.css';
import { TitleBar } from './titleBar';
import { AgentCount, AutopilotBar } from './autopilotBar';
import { NeedsYou } from './needsYou';
import { DRAG_TYPE, ItemRow } from './card';
import { MergeQueueBar } from './mergeQueueBar';

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
  /** The autopilot's details are folded out (kept in the view's state: per window). */
  autopilotOpen: boolean;
  setAutopilotOpen(open: boolean): void;
  openWorktree(key: string): void;
}

/**
 * The backlog: items in priority order in three lanes. Drag to reprioritize or to move between lanes; Start creates
 * (or shows) the item's worktree. Local items live in the repository's git dir, shared by all its worktrees.
 */
export function BacklogView({ items: posted, problems, integrations, autopilot, mergeQueue, workstreams, colors, workingOnly, setWorkingOnly, autopilotOpen, setAutopilotOpen, openWorktree }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  // A card dropped in a lane shows there at once, marked as saving, until the host has saved it.
  const busy = useBusy();
  const items = posted && withMoves(posted, busy.moves());
  // The Review lane shows only the tickets whose turn is the user's.
  const [mineOnly, setMineOnly] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [dropAt, setDropAt] = useState<{ status: BacklogStatus; before?: string }>();
  const worktreesOf = (item: BacklogItem) => workstreams.filter((w) => !w.isMain && branchMatches(item, w.branch));
  // Agents' proposals wait above the lanes until they're accepted.
  const proposed = workingOnly ? [] : (items ?? []).filter((i) => i.proposed);
  const agentCount = agentCountLabel(autopilot);
  const titles = new Map((items ?? []).map((i) => [i.id, i.title]));
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
    if (id !== before) act({ type: 'backlog', op: 'move', id, status: lane, before });
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
      {agentCount && autopilot && <AgentCount label={agentCount} autopilot={autopilot} titles={titles} open={autopilotOpen} setOpen={setAutopilotOpen} />}
      {autopilot?.enabled && <AutopilotBar autopilot={autopilot} titles={titles} open={autopilotOpen} setOpen={setAutopilotOpen} />}
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

