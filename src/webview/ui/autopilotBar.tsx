import { useEffect, useState } from 'preact/hooks';
import type { AutopilotState } from '../protocol';
import { send } from './api';
import { shortTime } from '../shortTime';
import { autopilotDetails, type DetailLine } from '../autopilotDetails';
import type { CardAgent } from '../../features/backlog/cardAgents';
import { act, BusyButton, useBusy } from './backlogBusy';
import { PauseOrResume, pausedAllLabel } from './pauseAll';

interface FoldProps {
  autopilot: AutopilotState;
  /** Ticket titles by id, for the details' lines. */
  titles: ReadonlyMap<string, string>;
  /** The agents on each ticket, with what they're doing (BL-175). */
  live?: ReadonlyMap<string, readonly CardAgent[]>;
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * The autopilot's bar, while it's on: what it does now. A click folds its details out (BL-153); its switch turns it off
 * (asking first while agents work). Try Now sits on the bar while it waits for the usage limit, in the details when open.
 */
export function AutopilotBar({ autopilot, titles, live, open, setOpen }: FoldProps) {
  return (
    <div class={`autopilot-box${autopilot.pausedAll !== undefined ? ' paused-all' : ''}`}>
      <div class="autopilot-bar">
        <button
          class="autopilot-what"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={open ? 'Click to fold the details' : "Click to see what it's doing"}
        >
          <i class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
          <i class="codicon codicon-rocket" />
          <span>
            <strong>Autopilot</strong>{' '}
            {autopilot.pausedAll !== undefined
              ? `· ${pausedAllLabel(autopilot.pausedAll)}: it holds until you resume.`
              : autopilot.elsewhere
              ? 'runs in another window.'
              : autopilot.waitingUntil
                ? autopilot.triedAt
                  ? `· Still limited: tried at ${shortTime(autopilot.triedAt)}; next try at ${shortTime(autopilot.waitingUntil)}.`
                  : `waits for Claude's usage limit to reset (${shortTime(autopilot.waitingUntil)}); paused agents go on then.`
                : autopilot.waitingForMemory
                  ? 'waits for free memory: too little to start an agent (flotilla.agents.minFreeMemoryMB). It tries again shortly.'
                  : autopilot.idle && !autopilot.running
                    ? `· Idle: ${autopilot.idle}.`
                    : `· ${autopilot.running} of ${autopilot.max} working${autopilot.waiting ? ` · ${autopilot.waiting} waiting` : ''}. ${autopilot.idle ? `Nothing more to start: ${autopilot.idle}.` : 'It takes To Do tickets from the top.'}`}
            {autopilot.away && !autopilot.elsewhere && <> {autopilot.away}.</>}
          </span>
        </button>
        {!open && autopilot.waitingUntil && !autopilot.elsewhere && <TryNow />}
        {!open && <PauseOrResume pausedAll={autopilot.pausedAll} running={autopilot.running} />}
        <Switch on />
      </div>
      {open && <Details autopilot={autopilot} titles={titles} live={live} />}
    </div>
  );
}

function TryNow() {
  return (
    <BusyButton
      class="try-now"
      message={{ type: 'backlog', op: 'tryNow' }}
      title="Asks Claude whether it takes work again: if it does, the paused agents go on now (top of the backlog first) and the autopilot takes To Do tickets again"
    >
      Try Now
    </BusyButton>
  );
}

/** The autopilot's switch: a control of its own, so a click on the bar can't turn it off. */
function Switch({ on }: { on: boolean }) {
  // Shared with the title's button (BL-117): either shows the switch working until the autopilot has turned.
  const switching = useBusy().has({ type: 'backlog', op: 'autopilot' });
  return (
    <button
      class={`autopilot-switch${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label="Autopilot"
      disabled={switching}
      aria-busy={switching}
      onClick={() => act({ type: 'backlog', op: 'autopilot' })}
      title={
        on
          ? 'Autopilot is on: click to turn it off (agents working keep working)'
          : 'Autopilot is off: click to turn it on (agents take To Do tickets from the top)'
      }
    >
      {on ? 'On' : 'Off'} <i class={`codicon codicon-${switching ? 'loading codicon-modifier-spin' : on ? 'circle-filled' : 'circle-outline'}`} />
    </button>
  );
}

/** The agent count, with the autopilot off (BL-107): a click folds out the same details, with the switch to turn it on. */
export function AgentCount({ label, autopilot, titles, live, open, setOpen }: FoldProps & { label: string }) {
  return (
    <div class={`autopilot-box off${autopilot.pausedAll !== undefined ? ' paused-all' : ''}`}>
      <div class="agent-count-line">
        <button
          class="agent-count"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={open ? 'Click to fold the details' : 'Click to see what the agents are doing'}
        >
          <i class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
          <i class="codicon codicon-hubot" />
          <span>{label}</span>
        </button>
        {!open && <PauseOrResume pausedAll={autopilot.pausedAll} running={autopilot.running} />}
        {open && <Switch on={false} />}
      </div>
      {open && <Details autopilot={autopilot} titles={titles} live={live} />}
    </div>
  );
}

/** A line that opens its ticket. */
function Line({ line }: { line: DetailLine }) {
  return (
    <li>
      <button class="autopilot-line" onClick={() => send({ type: 'backlog', op: 'open', id: line.id })} title={`Open ${line.id}`}>
        <span class="id">{line.id}</span>
        {line.title && <span class="title">{line.title}</span>}
        <span class="what">{line.text}</span>
        {line.status && (
          <span class={`status${line.stuck ? ' stuck' : ''}`}>
            <i class={`codicon codicon-${line.stuck ? 'warning' : 'tools'}`} /> {line.status.replace(/`/g, '')}
          </span>
        )}
      </button>
    </li>
  );
}

/** What the autopilot is doing (BL-153): live, as the bar is; the durations tick each half minute, each second with agents' statuses. */
function Details({ autopilot, titles, live }: { autopilot: AutopilotState; titles: ReadonlyMap<string, string>; live?: ReadonlyMap<string, readonly CardAgent[]> }) {
  const [now, setNow] = useState(() => new Date());
  const statuses = (autopilot.agents ?? []).some((g) => live?.get(g.id)?.some((c) => c.activity));
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === 'visible' && setNow(new Date()), statuses ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [statuses]);
  const d = autopilotDetails(autopilot, titles, now, live);
  return (
    <div class="autopilot-details">
      <div class="heading">Working ({d.agents.length})</div>
      {d.agents.length ? (
        <ul>
          {d.agents.map((l) => (
            <Line key={`a-${l.id}`} line={l} />
          ))}
        </ul>
      ) : (
        <div class="none">No agent is working.</div>
      )}
      {d.waiting.length > 0 && (
        <>
          <div class="heading">Waiting to start ({d.waiting.length}), in order</div>
          <ol>
            {d.waiting.map((l) => (
              <Line key={`w-${l.id}`} line={l} />
            ))}
          </ol>
        </>
      )}
      {d.idle && <div class="idle">Idle: {d.idle}.</div>}
      <div class="limit">
        <span>
          Up to {d.max} {d.max === 1 ? 'agent' : 'agents'} at once (flotilla.agents.maxRunning)
        </span>
        <BusyButton
          class="step"
          aria-label="One agent fewer"
          title="One agent fewer at once"
          disabled={d.max <= 1}
          message={{ type: 'backlog', op: 'maxAgents', max: d.max - 1 }}
          icon="remove"
        />
        <BusyButton
          class="step"
          aria-label="One agent more"
          title="One agent more at once"
          message={{ type: 'backlog', op: 'maxAgents', max: d.max + 1 }}
          icon="add"
        />
        {d.tryNow && <TryNow />}
      </div>
      {(autopilot.pausedAll !== undefined || autopilot.running > 0) && (
        <div class="pause-all-row">
          <span>{autopilot.pausedAll !== undefined ? `${pausedAllLabel(autopilot.pausedAll)}: nothing starts until you resume.` : 'Pause every agent working, their chats kept:'}</span>
          <PauseOrResume pausedAll={autopilot.pausedAll} running={autopilot.running} />
        </div>
      )}
    </div>
  );
}
