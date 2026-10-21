import type { AutopilotState } from '../protocol';
import { send } from './api';
import { shortTime } from '../shortTime';
import { BusyButton } from './backlogBusy';
import { PauseAllButton } from './pauseAll';

/** The autopilot's bar, while it's on: what it does now, and Try Now while it waits for the usage limit. */
export function AutopilotBar({ autopilot }: { autopilot: AutopilotState }) {
  return (
    <div class="autopilot-bar">
      <button class="autopilot-what" onClick={() => send({ type: 'backlog', op: 'autopilot' })} title="Click to turn the autopilot off">
        <i class="codicon codicon-rocket" />
        <span>
          <strong>Autopilot</strong>{' '}
          {autopilot.elsewhere
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
      {autopilot.waitingUntil && !autopilot.elsewhere && (
        <BusyButton
          class="try-now"
          message={{ type: 'backlog', op: 'tryNow' }}
          title="Asks Claude whether it takes work again: if it does, the paused agents go on now (top of the backlog first) and the autopilot takes To Do tickets again"
        >
          Try Now
        </BusyButton>
      )}
      {autopilot.running > 0 && <PauseAllButton />}
    </div>
  );
}
