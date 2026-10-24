import { send } from './api';
import { BusyButton } from './backlogBusy';
import type { Props } from './backlog';
import './titleBar.css';

/** How long something has waited, short: "5m", "3h", "2d". */
/** The backlog's title bar: its name and the actions on the whole backlog. */
export function TitleBar({ integrations, autopilot, workingOnly, setWorkingOnly }: Pick<Props, 'integrations' | 'autopilot' | 'workingOnly' | 'setWorkingOnly'>) {
  return (
    <div class="tool-title backlog-title">
      <span>Backlog</span>
      <span class="title-actions">
        {integrations > 0 && (
          <BusyButton class="icon" aria-label="Refresh Issues" message={{ type: 'backlog', op: 'refresh' }} icon="refresh" />
        )}
        {autopilot && (
          <BusyButton
            class={`icon autopilot-toggle${autopilot.enabled ? ' on' : ''}`}
            aria-pressed={autopilot.enabled}
            aria-label={
              autopilot.enabled
                ? 'Autopilot is on: agents take To Do tickets and work on them. Click to turn it off.'
                : 'Autopilot: let agents take To Do tickets and work on them, without you starting each one'
            }
            message={{ type: 'backlog', op: 'autopilot' }}
            icon="rocket"
          />
        )}
        <button
          class={`icon working-filter${workingOnly ? ' on' : ''}`}
          aria-pressed={workingOnly}
          aria-label={workingOnly ? 'Showing only tickets being worked on: click to show them all' : 'Show only tickets being worked on (an agent runs or is paused)'}
          onClick={() => setWorkingOnly(!workingOnly)}
        >
          <i class={`codicon codicon-${workingOnly ? 'filter-filled' : 'filter'}`} />
        </button>
        <BusyButton
          class="icon"
          aria-label="Check All: what each ticket says is going on, against what really runs (Clean Up what doesn't)"
          message={{ type: 'backlog', op: 'checkAll' }}
          icon="pulse"
        />
        <BusyButton class="icon" aria-label="Plan the Backlog with Claude" message={{ type: 'backlog', op: 'plan' }} icon="sparkle" />
        <button class="icon" aria-label="Integrations (Jira, GitHub Issues)…" onClick={() => send({ type: 'backlog', op: 'integrations' })}>
          <i class="codicon codicon-plug" />
        </button>
        <button class="icon" aria-label="Add Item" onClick={() => send({ type: 'backlog', op: 'new' })}>
          <i class="codicon codicon-add" />
        </button>
      </span>
    </div>
  );
}
