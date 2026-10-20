import { useEffect, useRef, useState } from 'preact/hooks';
import { agentCountLabel } from './agentCount';
import { branchMatches, laneOf, readyToMerge, type BacklogLane } from '../../features/backlog/backlog';
import { CARD_AGENT_LABEL, cardAgents, type CardAgent } from '../../features/backlog/cardAgents';
import { mergeLabel, unmergedWarning } from '../../features/backlog/merged';
import { oldestFirst, type NeedKind } from '../../features/backlog/needs';
import { agentOf, hasActiveAgent } from '../../features/backlog/activeAgent';
import { conflictsOf } from '../../features/backlog/mainDrift';
import { fixesFor, fixLabel } from '../../features/backlog/review';
import { runLabel } from '../../features/backlog/runBlocks';
import { TURN_ICON, TURN_LABEL, turnOf } from '../../features/backlog/turn';
import type { BacklogItemView as BacklogItem, BacklogProblem, BacklogStatus, WorkstreamView, AutopilotState } from '../protocol';
import { menuContext, send } from './api';
import { PriorityPicker } from './priority';
import './priority.css';

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

const DRAG_TYPE = 'application/x-flotilla-backlog';

interface Props {
  items: BacklogItem[] | undefined;
  /** Integrations whose issues don't load. */
  problems: BacklogProblem[];
  /** How many integrations are connected. */
  integrations: number;
  autopilot?: AutopilotState;
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
export function BacklogView({ items, problems, integrations, autopilot, workstreams, colors, workingOnly, setWorkingOnly, openWorktree }: Props) {
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
      <div class="tool-title backlog-title">
        <span>Backlog</span>
        <span class="title-actions">
          {integrations > 0 && (
            <button class="icon" aria-label="Refresh Issues" onClick={() => send({ type: 'backlog', op: 'refresh' })}>
              <i class="codicon codicon-refresh" />
            </button>
          )}
          {autopilot && (
            <button
              class={`icon autopilot-toggle${autopilot.enabled ? ' on' : ''}`}
              aria-pressed={autopilot.enabled}
              aria-label={
                autopilot.enabled
                  ? 'Autopilot is on: agents take To Do tickets and work on them. Click to turn it off.'
                  : 'Autopilot: let agents take To Do tickets and work on them, without you starting each one'
              }
              onClick={() => send({ type: 'backlog', op: 'autopilot' })}
            >
              <i class="codicon codicon-rocket" />
            </button>
          )}
          <button
            class={`icon working-filter${workingOnly ? ' on' : ''}`}
            aria-pressed={workingOnly}
            aria-label={workingOnly ? 'Showing only tickets being worked on: click to show them all' : 'Show only tickets being worked on (an agent runs or is paused)'}
            onClick={() => setWorkingOnly(!workingOnly)}
          >
            <i class={`codicon codicon-${workingOnly ? 'filter-filled' : 'filter'}`} />
          </button>
          <button class="icon" aria-label="Plan the Backlog with Claude" onClick={() => send({ type: 'backlog', op: 'plan' })}>
            <i class="codicon codicon-sparkle" />
          </button>
          <button class="icon" aria-label="Integrations (Jira, GitHub Issues)…" onClick={() => send({ type: 'backlog', op: 'integrations' })}>
            <i class="codicon codicon-plug" />
          </button>
          <button class="icon" aria-label="Add Item" onClick={() => send({ type: 'backlog', op: 'new' })}>
            <i class="codicon codicon-add" />
          </button>
        </span>
      </div>
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
      {autopilot?.enabled && (
        <button class="autopilot-bar" onClick={() => send({ type: 'backlog', op: 'autopilot' })} title="Click to turn the autopilot off">
          <i class="codicon codicon-rocket" />
          <span>
            <strong>Autopilot</strong>{' '}
            {autopilot.elsewhere
              ? 'runs in another window.'
              : autopilot.waitingUntil
                ? `waits for Claude's usage limit to reset (${new Date(autopilot.waitingUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}); paused agents go on then.`
                : autopilot.waitingForMemory
                  ? 'waits for free memory: too little to start an agent (flotilla.agents.minFreeMemoryMB). It tries again shortly.'
                  : `· ${autopilot.running} of ${autopilot.max} working${autopilot.waiting ? ` · ${autopilot.waiting} waiting` : ''}. It takes To Do tickets from the top.`}
          </span>
        </button>
      )}
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
            <button class="icon" aria-label="Accept All" onClick={() => send({ type: 'backlog', op: 'acceptAll' })}>
              <i class="codicon codicon-check-all" />
            </button>
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

/** How long something has waited, short: "5m", "3h", "2d". */
function waited(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

const NEED_ICON: Record<NeedKind, string> = { asking: 'comment-discussion', yours: 'eye', approved: 'pass-filled', stopped: 'debug-pause', failed: 'error', queued: 'clock' };
const NEED_TITLE: Record<NeedKind, string> = {
  asking: 'Has a question for you',
  yours: 'Ready for your review',
  approved: 'Approved, not merged yet',
  stopped: 'Its review stopped',
  failed: "The autopilot couldn't start it",
  queued: 'Your reply waits for a free agent',
};

/**
 * What waits on the user, across the backlog, oldest first: an agent's question, work ready for review, approved
 * work, a stopped review, a start that failed. Each row has the actions for it; folded away when there's nothing.
 */
function NeedsYou({ items }: { items: BacklogItem[] }) {
  const [open, setOpen] = useState(true);
  const rows = oldestFirst(items);
  if (!rows.length) return null;
  return (
    <div class="group lane needs-lane">
      <div class="row group-head" onClick={() => setOpen(!open)}>
        <span class="name">Needs you</span>
        <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} lane-chev`} aria-label={open ? 'Hide what needs you' : 'Show what needs you'} />
        <span class="badge">{rows.length}</span>
      </div>
      {open && (
        <div class="lane-body">
          {rows.map((item) => (
            <NeedRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function NeedRow({ item }: { item: BacklogItem }) {
  const need = item.need!;
  const r = item.review;
  const age = waited(need.since);
  const open = () => send({ type: 'backlog', op: 'open', id: item.id });
  // The actions of the ticket, here: the first fix of a stopped review is the one to offer first.
  const fix = r?.state === 'stopped' ? fixesFor(r.stop?.kind, !!r.stop?.task)[0] : undefined;
  return (
    <div
      class={`row backlog-item need need-${need.kind}`}
      tabIndex={0}
      title={NEED_TITLE[need.kind]}
      onClick={open}
      onKeyDown={(e) => {
        // Enter on one of the row's buttons is theirs: only the row itself opens the ticket.
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      }}
    >
      <i class={`codicon codicon-${NEED_ICON[need.kind]} need-icon`} />
      <span class="item-id">{item.id}</span>
      <span class="name">{item.title}</span>
      <span class="need-line">{need.line}</span>
      {age && <span class="need-age">{age}</span>}
      <span class="need-actions" onClick={(e) => e.stopPropagation()}>
        {need.kind === 'asking' && (
          <button class="button" onClick={() => send({ type: 'backlog', op: 'comment', id: item.id })} title="Opens the ticket with the comment box focused: answer there">
            <i class="codicon codicon-comment" /> Answer
          </button>
        )}
        {need.kind === 'yours' && (
          <>
            <button class="button secondary" onClick={() => send({ type: 'backlog', op: 'comment', id: item.id })} title="Opens the ticket with the comment box focused: write what should change">
              <i class="codicon codicon-request-changes" /> Request Changes
            </button>
            <button class="button" onClick={() => send({ type: 'backlog', op: 'approve', id: item.id })}>
              <i class="codicon codicon-check" /> Approve
            </button>
          </>
        )}
        {need.kind === 'stopped' && fix && (
          <button class="button" onClick={() => send({ type: 'backlog', op: 'fix', id: item.id, fix })}>
            {fixLabel(fix, r?.stop?.kind)}
          </button>
        )}
        {need.kind === 'queued' && (
          <button class="button" onClick={() => send({ type: 'backlog', op: 'prioritize', id: item.id })} title="Starts it now, above the limit, or pauses a running agent to make room">
            <i class="codicon codicon-arrow-up" /> Prioritize
          </button>
        )}
        {need.kind === 'failed' && (
          <button class="button" onClick={() => send({ type: 'backlog', op: 'start', id: item.id })} title="Creates its worktree if needed and starts an agent there: it runs in the background and reports in the ticket">
            <i class="codicon codicon-play" /> Run
          </button>
        )}
        <button class="button secondary" onClick={open}>
          Open
        </button>
      </span>
    </div>
  );
}

interface RowProps {
  item: BacklogItem;
  icon: string;
  /** The worktrees working on it: one, or several for an epic. */
  worktrees: WorkstreamView[];
  /** The agents on it, with what each is doing (BL-96). */
  agents: CardAgent[];
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

function ItemRow({ item, icon, worktrees, agents, color, renaming, setRenaming, dropBefore, onDragOver, onDrop, openWorktree }: RowProps) {
  const done = item.status === 'done';
  // Issues from integrations are ordered, renamed and closed in their tracker.
  const remote = item.source;
  const worktree = worktrees[0];
  const setStatus = (status: BacklogStatus) => send({ type: 'backlog', op: 'update', id: item.id, status });
  // Whose turn its review is (local items only: an issue's review is in its tracker).
  const turn = remote || item.proposed ? undefined : turnOf(item);
  return (
    <div
      class={`row backlog-item st-${item.status}${dropBefore ? ' drop-before' : ''}`}
      tabIndex={0}
      // Right-click (or Shift+F10 on the focused card) opens VS Code's menu; package.json says what's in it.
      data-vscode-context={item.proposed || renaming ? undefined : menuContext('backlogItem', { backlogId: item.id, backlogLocal: !remote, backlogDone: done, backlogWorktree: worktrees.length > 0, backlogRunnable: !!item.run, backlogAgent: remote ? '' : (agentOf(item, worktrees) ?? ''), backlogReadyToMerge: !remote && readyToMerge(item) })}
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
      {item.parent && (
        <span class="parent-chip" data-tip={`Part of ${item.parent}`}>
          <i class="codicon codicon-type-hierarchy-sub" />
          {item.parent}
        </span>
      )}
      {renaming ? (
        <RenameBox item={item} onDone={() => setRenaming(false)} />
      ) : (
        <>
          <span class="name">{item.title}</span>
          {item.summary && <span class="desc">{item.summary}</span>}
        </>
      )}
      {!renaming && turn && (
        <span class={`turn-chip turn-${turn.kind}${turn.mine ? ' mine' : ''}`} data-tip={`${TURN_LABEL[turn.kind]}: ${turn.who}`}>
          <i class={`codicon codicon-${TURN_ICON[turn.kind]}`} />
          {turn.kind === 'paused' ? 'Paused' : turn.who}
        </span>
      )}
      {!renaming &&
        agents.map((a) => (
          <span key={a.name} class={`agent-chip ${a.state}`} data-tip={`Agent ${a.name}: ${CARD_AGENT_LABEL[a.state]}`}>
            {a.state === 'paused' ? <i class="codicon codicon-debug-pause" /> : <span class={`dot ${a.state}`} />}
            {a.name}
          </span>
        ))}
      {!renaming && !item.proposed && item.activity > 0 && (
        <span class="activity-count" aria-label={`${item.activity} activity entries`}>
          <i class="codicon codicon-comment" />
          {item.activity}
        </span>
      )}
      {!renaming && !item.proposed && item.merge && mergeLabel(item.merge) && (
        // Whether its work is merged (from git): "merged into main", "not merged (3 commits)", "partly merged".
        <span class={`merge-chip ${item.merge.state}`} data-tip={item.merge.branches.map((b) => `${b.branch}: ${b.state}`).join('\n')}>
          {mergeLabel(item.merge)}
        </span>
      )}
      {!renaming && unmergedWarning(item, item.merge) && (
        <span class="merge-warning" data-tip="Done, but its work isn't merged. Open its ticket to merge it, dismiss it or open its branch.">
          <i class="codicon codicon-warning" />
        </span>
      )}
      {!renaming && conflictsOf(item).length > 0 && (
        <span
          class="drift-badge conflict"
          data-tip={conflictsOf(item)
            .map((b) => `${b.branch} conflicts with ${item.base ?? 'main'} in:\n${b.conflicts.join('\n')}`)
            .join('\n\n')}
          data-tip-hint={`Update from ${item.base ?? 'main'} in the ticket hands the merge to its agent`}
        >
          <i class="codicon codicon-git-merge" />
          conflicts with {item.base ?? 'main'}
        </span>
      )}
      {!renaming && item.clash && (
        <span
          class="drift-badge"
          data-tip={`The autopilot holds it back until ${item.clash.with} is merged: both change ${item.clash.files.join(', ')}. Start it yourself to go ahead anyway`}
        >
          <i class="codicon codicon-debug-pause" />
          after {item.clash.with}
        </span>
      )}
      {!renaming && item.agent?.light && !item.agent.model && (
        <span class="drift-badge" data-tip="Light: small, mechanical work, on the light model (flotilla.agents.lightModel). Reviewed by the default model; moves up to it when it turns out hard">
          <i class="codicon codicon-feather" />
          Light
        </span>
      )}
      {!renaming && item.agent?.movedUp && item.agent.model === item.agent.movedUp.to && (
        <span class="drift-badge" data-tip={`Moved up from ${item.agent.movedUp.from} to ${item.agent.movedUp.to}: ${item.agent.movedUp.reason}`}>
          <i class="codicon codicon-arrow-up" />
          {item.agent.movedUp.to}
        </span>
      )}
      {!renaming && item.waitsFor && (
        <span class="drift-badge" data-tip={`Depends on ${item.waitsFor.join(', ')}: waits for ${item.waitsFor.length === 1 ? 'it' : 'them'} to be merged`}>
          <i class="codicon codicon-debug-pause" />
          {item.waitsFor.join(', ')}
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
      {!renaming && item.proposed && (
        <span class="proposal-actions" onClick={(e) => e.stopPropagation()}>
          <button class="icon" aria-label={`Accept${item.proposed.by ? ` (Proposed by ${item.proposed.by})` : ''}`} onClick={() => send({ type: 'backlog', op: 'accept', id: item.id })}>
            <i class="codicon codicon-check" />
          </button>
          <button
            class="icon"
            aria-label="Discuss It with an Agent"
            title="An agent talks it through with you in the ticket, and writes what's agreed into it"
            onClick={() => send({ type: 'backlog', op: 'discuss', id: item.id })}
          >
            <i class="codicon codicon-comment-discussion" />
          </button>
          <button class="icon" aria-label="Dismiss" onClick={() => send({ type: 'backlog', op: 'dismiss', id: item.id })}>
            <i class="codicon codicon-close" />
          </button>
        </span>
      )}
      {!renaming && item.run && (
        <button
          class="icon run-button"
          aria-label={`Run ${item.id}`}
          data-tip={runLabel(item.run)}
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'backlog', op: 'run', id: item.id });
          }}
        >
          <i class="codicon codicon-play" />
        </button>
      )}
      {!renaming && !item.proposed && (
        <span class={`hover-actions${item.creating ? ' creating' : ''}`} onClick={(e) => e.stopPropagation()}>
          {!done && item.creating && (
            <span class="icon" role="status" aria-label="Creating its worktree…" title="Creating its worktree…">
              <i class="codicon codicon-loading codicon-modifier-spin" />
            </span>
          )}
          {!done && !item.creating && (
            <button
              class="icon"
              aria-label={worktree ? 'Start an Agent on It (in Its Worktree)' : 'Start an Agent on It (Creates Its Worktree)'}
              title={`${worktree ? 'Start an Agent on It (in Its Worktree)' : 'Start an Agent on It (Creates Its Worktree)'}: it runs in the background and reports in the ticket`}
              onClick={() => send({ type: 'backlog', op: 'start', id: item.id })}
            >
              <i class="codicon codicon-play" />
            </button>
          )}
          {!done && !item.creating && <CreateWorktreeIcons id={item.id} another={worktrees.length > 0} />}
          {remote ? (
            <a class="icon" href={remote.url} aria-label={`Open in ${remote.label}`}>
              <i class="codicon codicon-link-external" />
            </a>
          ) : (
            <>
              {item.status === 'todo' && (
                <button
                  class="icon"
                  aria-label="Discuss It with an Agent"
                  title="An agent talks it through with you in the ticket, and writes what's agreed into it"
                  onClick={() => send({ type: 'backlog', op: 'discuss', id: item.id })}
                >
                  <i class="codicon codicon-comment-discussion" />
                </button>
              )}
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

/**
 * A card's Create Worktree, as the ticket's (a split button): a click creates a new worktree at once, its branch named
 * without asking; the arrow's menu names the branch first.
 */
function CreateWorktreeIcons({ id, another }: { id: string; another: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
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
  const label = another ? 'Add a Worktree' : 'Create Worktree';
  return (
    <span class="split-icons" ref={box}>
      <button class="icon" aria-label={label} data-tip={`${label}: a new worktree and branch for it at once, without an agent`} onClick={() => send({ type: 'backlog', op: 'createWorktree', id })}>
        <i class="codicon codicon-git-branch" />
      </button>
      <button class="icon more" aria-label="More Ways to Create a Worktree…" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i class="codicon codicon-chevron-down" />
      </button>
      {open && (
        <span class="menu priority-menu split-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              send({ type: 'backlog', op: 'createWorktree', id, named: true });
            }}
          >
            <i class="codicon codicon-edit" />
            {another ? 'Add a Worktree with Branch Name…' : 'Create Worktree with Branch Name…'}
          </button>
        </span>
      )}
    </span>
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
