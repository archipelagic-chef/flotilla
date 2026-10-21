import { BusyButton } from './backlogBusy';

/** Pause All (BL-160): every agent working pauses, its chat kept; Resume All goes on with exactly those. */
export function PauseAllButton() {
  return (
    <BusyButton class="try-now pause-all" message={{ type: 'backlog', op: 'pauseAll' }} icon="debug-pause" title="Pauses every agent working (their chats are kept), and starts nothing new until Resume All">
      Pause All
    </BusyButton>
  );
}

/** While Pause All holds (BL-160): how many it paused, and Resume All. Instead of the autopilot's bar and the agent count. */
export function PausedAllBar({ count, autopilot }: { count: number; autopilot: boolean }) {
  return (
    <div class="autopilot-bar paused-all-bar">
      <span class="autopilot-what">
        <i class="codicon codicon-debug-pause" />
        <span>
          <strong>All agents paused</strong> ({count}){autopilot ? '. The autopilot holds until you resume.' : '. Nothing starts on its own until you resume.'}
        </span>
      </span>
      <BusyButton class="try-now" message={{ type: 'backlog', op: 'resumeAll' }} icon="debug-continue" title="Resumes the agents Pause All paused, top of the backlog first, within flotilla.agents.maxRunning">
        Resume All
      </BusyButton>
    </div>
  );
}
