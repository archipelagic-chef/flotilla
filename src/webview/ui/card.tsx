import { useEffect, useRef, useState } from 'preact/hooks';
import { readyToMerge } from '../../features/backlog/backlog';
import { CARD_AGENT_LABEL, type CardAgent } from '../../features/backlog/cardAgents';
import { statusLine } from '../../features/chats/activity';
import { mergeLabel, unmergedWarning } from '../../features/backlog/merged';
import { agentOf } from '../../features/backlog/activeAgent';
import { conflictsOf } from '../../features/backlog/mainDrift';
import { runLabel } from '../../features/backlog/runBlocks';
import { TURN_ICON, TURN_LABEL, turnOf } from '../../features/backlog/turn';
import type { BacklogItemView as BacklogItem, BacklogStatus, WorkstreamView } from '../protocol';
import { menuContext, send } from './api';
import { act, BusyButton, useBusy } from './backlogBusy';
import { PriorityPicker } from './priority';

export const DRAG_TYPE = 'application/x-flotilla-backlog';

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
  /** In the merge queue, behind other tickets: its menu has Merge Next (BL-144). */
  queuedBehind?: boolean;
  dropBefore: boolean;
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
  openWorktree(key: string): void;
}

/** The agent's state on a worktree chip, as on the worktree tabs. */
const AGENT_DOT: Record<string, string | undefined> = { 'waiting-for-input': 'waiting', error: 'error', working: 'working', done: 'done' };

export function ItemRow({ item, icon, worktrees, agents, color, renaming, setRenaming, queuedBehind, dropBefore, onDragOver, onDrop, openWorktree }: RowProps) {
  // A card whose button is working keeps its hover buttons shown (BL-117).
  const busy = useBusy();
  const done = item.status === 'done';
  // Issues from integrations are ordered, renamed and closed in their tracker.
  const remote = item.source;
  const worktree = worktrees[0];
  const setStatus = (status: BacklogStatus) => send({ type: 'backlog', op: 'update', id: item.id, status });
  // Whose turn its review is (local items only: an issue's review is in its tracker).
  const turn = remote || item.proposed ? undefined : turnOf(item);
  // A working agent's status, on a line of its own (BL-175).
  const live = agents.find((a) => a.activity);
  return (
    <div
      class={`row backlog-item st-${item.status}${dropBefore ? ' drop-before' : ''}${live && !renaming ? ' has-status' : ''}`}
      tabIndex={0}
      // Right-click (or Shift+F10 on the focused card) opens VS Code's menu; package.json says what's in it.
      data-vscode-context={item.proposed || renaming ? undefined : menuContext('backlogItem', { backlogId: item.id, backlogLocal: !remote, backlogDone: done, backlogWorktree: worktrees.length > 0, backlogRunnable: !!item.run, backlogAgent: remote ? '' : (agentOf(item, worktrees) ?? ''), backlogReadyToMerge: !remote && readyToMerge(item), backlogQueued: !!queuedBehind })}
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
        else if (e.key === 'Delete' && !remote) act({ type: 'backlog', op: 'delete', id: item.id });
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
      {!renaming && item.demo && (
        <button
          class="demo-mark"
          data-tip="It has a recorded demo: click to see it in the ticket"
          aria-label="Show its demo"
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'backlog', op: 'demo', id: item.id });
          }}
        >
          <i class="codicon codicon-device-camera-video" />
          demo
        </button>
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
      {!renaming && item.checks && (
        <span class="drift-badge" data-tip={`Its merge's checks are running (${item.checks.step ?? 'Checks'}): the ticket shows them`}>
          <i class="codicon codicon-loading codicon-modifier-spin" />
          checks{item.checks.percent !== undefined ? ` ${item.checks.percent}%` : ''}
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
          <BusyButton class="icon" aria-label={`Accept${item.proposed.by ? ` (Proposed by ${item.proposed.by})` : ''}`} message={{ type: 'backlog', op: 'accept', id: item.id }} icon="check" />
          <BusyButton
            class="icon"
            aria-label="Discuss It with an Agent"
            title="An agent talks it through with you in the ticket, and writes what's agreed into it"
            message={{ type: 'backlog', op: 'discuss', id: item.id }}
            icon="comment-discussion"
          />
          <BusyButton class="icon" aria-label="Dismiss" message={{ type: 'backlog', op: 'dismiss', id: item.id }} icon="close" />
        </span>
      )}
      {!renaming && item.run && (
        <BusyButton
          class="icon run-button"
          aria-label={`Run ${item.id}`}
          data-tip={runLabel(item.run)}
          onClick={(e) => e.stopPropagation()}
          message={{ type: 'backlog', op: 'run', id: item.id }}
          icon="play"
        />
      )}
      {!renaming && !item.proposed && (
        <span class={`hover-actions${item.creating || busy.onItem(item.id) ? ' creating' : ''}`} onClick={(e) => e.stopPropagation()}>
          {!done && item.creating && (
            <span class="icon" role="status" aria-label="Creating its worktree…" title="Creating its worktree…">
              <i class="codicon codicon-loading codicon-modifier-spin" />
            </span>
          )}
          {!done && !item.creating && (
            <BusyButton
              class="icon"
              aria-label={worktree ? 'Start an Agent on It (in Its Worktree)' : 'Start an Agent on It (Creates Its Worktree)'}
              title={`${worktree ? 'Start an Agent on It (in Its Worktree)' : 'Start an Agent on It (Creates Its Worktree)'}: it runs in the background and reports in the ticket`}
              message={{ type: 'backlog', op: 'start', id: item.id }}
              icon="play"
            />
          )}
          {!done && !item.creating && <CreateWorktreeIcons id={item.id} another={worktrees.length > 0} />}
          {remote ? (
            <a class="icon" href={remote.url} aria-label={`Open in ${remote.label}`}>
              <i class="codicon codicon-link-external" />
            </a>
          ) : (
            <>
              {item.status === 'todo' && (
                <BusyButton
                  class="icon"
                  aria-label="Discuss It with an Agent"
                  title="An agent talks it through with you in the ticket, and writes what's agreed into it"
                  message={{ type: 'backlog', op: 'discuss', id: item.id }}
                  icon="comment-discussion"
                />
              )}
              <button class="icon" aria-label="Link to an Issue (Jira, GitHub)…" onClick={() => send({ type: 'backlog', op: 'link', id: item.id })}>
                <i class="codicon codicon-link" />
              </button>
              <button class="icon" aria-label="Rename" onClick={() => setRenaming(true)}>
                <i class="codicon codicon-edit" />
              </button>
              <BusyButton class="icon" aria-label="Delete…" message={{ type: 'backlog', op: 'delete', id: item.id }} icon="trash" />
            </>
          )}
        </span>
      )}
      {!renaming && live?.activity && <AgentLine agent={live} />}
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

/** A working agent's line on its card (BL-175): what it does now, with its plan's progress; a warning when it looks stuck. */
function AgentLine({ agent }: { agent: CardAgent }) {
  const running = !!agent.activity?.tool && !agent.activity.tool.done;
  // Its command's clock goes on counting between updates.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const line = statusLine(agent.activity!) ?? '';
  return (
    <span class={`agent-status${agent.stuck ? ' stuck' : ''}`} data-tip={agent.stuck ? `Agent ${agent.name} looks stuck: ${agent.stuck}` : `Agent ${agent.name}: ${line}`}>
      <i class={`codicon ${agent.stuck ? 'codicon-warning' : running ? 'codicon-loading codicon-modifier-spin' : 'codicon-tools'}`} />
      <span class="agent-status-text">{agent.stuck ? `Looks stuck: ${agent.stuck.replace(/`/g, '')}` : line.replace(/`/g, '')}</span>
    </span>
  );
}
