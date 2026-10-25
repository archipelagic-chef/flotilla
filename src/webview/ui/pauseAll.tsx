import { BusyButton } from './backlogBusy';

/** Pause All (BL-160): every agent working pauses, its chat kept; Resume All goes on with exactly those. */
export function PauseAllButton() {
  return (
    <BusyButton
      class="try-now pause-all"
      message={{ type: 'backlog', op: 'pauseAll' }}
      icon="debug-pause"
      title="Pauses every agent working (their chats are kept), and starts nothing new until Resume All"
    >
      Pause All
    </BusyButton>
  );
}

/** Resume All (BL-160): the agents Pause All paused go on, top of the backlog first, within the limit. */
export function ResumeAllButton() {
  return (
    <BusyButton
      class="try-now resume-all"
      message={{ type: 'backlog', op: 'resumeAll' }}
      icon="debug-continue"
      title="Resumes the agents Pause All paused, top of the backlog first, within flotilla.agents.maxRunning"
    >
      Resume All
    </BusyButton>
  );
}

/** Pause All or Resume All, whichever applies now: Resume All while Pause All holds, Pause All while agents work. */
export function PauseOrResume({ pausedAll, running }: { pausedAll?: number; running: number }) {
  return pausedAll !== undefined ? <ResumeAllButton /> : running > 0 ? <PauseAllButton /> : null;
}

/** What the bar and the agent count say while Pause All holds: "All agents paused (5)". */
export const pausedAllLabel = (n: number) => `All agents paused (${n})`;
