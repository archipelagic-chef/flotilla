import { useState } from 'preact/hooks';
import type {
  RunTicket,
  ScheduledOp,
  ScheduledTaskView,
  ScheduledView,
} from '../scheduledProtocol';
import { send } from './api';
import './scheduled.css';
import { soon } from './scheduledSoon';

const act = (op: ScheduledOp, name?: string, day?: string) => send({ type: 'scheduledAction', op, ...(name ? { name } : {}), ...(day ? { day } : {}) });

/** "Mon 2 Nov, 06:00" (this year's without the year). */
function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** What a task's line says it's doing: running, waiting, when it runs next, or what's wrong with its file. */
function Status({ task }: { task: ScheduledTaskView }) {
  if (task.error)
    return (
      <span class="scheduled-status error" title={task.error}>
        <i class="codicon codicon-warning" /> {task.error}
      </span>
    );
  if (task.running)
    return (
      <span class="scheduled-status running">
        <i class="codicon codicon-loading codicon-modifier-spin" /> Running
      </span>
    );
  if (task.proposed)
    return (
      <span class="scheduled-status proposed">
        <i class="codicon codicon-lightbulb" /> Proposed by {task.proposed}: it runs once you accept it
      </span>
    );
  if (task.paused)
    return (
      <span class="scheduled-status paused" title="It doesn't run on its schedule until you Resume it; Run Now still runs it">
        <i class="codicon codicon-debug-pause" /> Paused
      </span>
    );
  if (task.due)
    return (
      <span class="scheduled-status waiting" title={task.waits ? 'Due: it starts once that no longer holds it' : 'Due: it starts within a few minutes'}>
        <i class="codicon codicon-clock" /> Due{task.waits ? `, waits: ${task.waits}` : ''}
      </span>
    );
  return <span class="scheduled-status">{task.next ? `Next: ${when(task.next)}` : 'Ran: not again'}</span>;
}

const TICKET_STATE: Record<RunTicket['state'], { icon: string; text: string }> = {
  accepted: { icon: 'check', text: 'accepted' },
  dismissed: { icon: 'close', text: 'dismissed' },
  proposed: { icon: 'inbox', text: 'in Needs you' },
};

/** The tickets a run proposed (BL-262), each linked, with whether you accepted or dismissed it. */
function RunTickets({ tickets }: { tickets?: RunTicket[] }) {
  if (!tickets?.length) return null;
  return (
    <ul class="scheduled-tickets" aria-label="The tickets it proposed">
      {tickets.map((t) => (
        <li key={t.id} class={`is-${t.state}`}>
          {t.state === 'dismissed' ? (
            <span class="scheduled-ticket">
              {t.id} {t.title}
            </span>
          ) : (
            <button class="link scheduled-ticket" title={`Open ${t.id}`} onClick={() => act('ticket', t.id)}>
              {t.id} {t.title}
            </button>
          )}
          <span class="scheduled-ticket-state">
            <i class={`codicon codicon-${TICKET_STATE[t.state].icon}`} /> {TICKET_STATE[t.state].text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A task: its title and schedule, its status, its last report, and its actions; its earlier reports in a fold. */
function TaskCard({ task }: { task: ScheduledTaskView }) {
  const [open, setOpen] = useState(false);
  const [last, ...earlier] = task.reports;
  return (
    <div class={`scheduled-task${task.proposed ? ' is-proposed' : ''}${task.error ? ' is-wrong' : ''}`}>
      <div class="scheduled-head">
        <span class="scheduled-title">{task.title}</span>
        {task.schedule && <span class="scheduled-schedule">{task.schedule}</span>}
        <span class="scheduled-actions">
          {task.proposed ? (
            <>
              <button
                class="icon"
                title="Accept the task: it runs on its schedule"
                aria-label={`Accept ${task.title}`}
                onClick={() => act('accept', task.name)}
              >
                <i class="codicon codicon-check" />
              </button>
              <button class="icon" title="Dismiss the task: its file is deleted" aria-label={`Dismiss ${task.title}`} onClick={() => act('dismiss', task.name)}>
                <i class="codicon codicon-close" />
              </button>
            </>
          ) : (
            !task.error && (
              <>
                <button
                  class="icon"
                  title={task.paused ? 'Resume: it runs on its schedule again' : "Pause: it doesn't run on its schedule until you resume it"}
                  aria-label={`${task.paused ? 'Resume' : 'Pause'} ${task.title}`}
                  onClick={() => act(task.paused ? 'resume' : 'pause', task.name)}
                >
                  <i class={`codicon codicon-${task.paused ? 'debug-continue' : 'debug-pause'}`} />
                </button>
                <button
                  class="icon"
                  title="Run Now: its agent starts at once, if an agent slot is free"
                  aria-label={`Run ${task.title} now`}
                  disabled={task.running}
                  onClick={() => act('run', task.name)}
                >
                  <i class="codicon codicon-play" />
                </button>
              </>
            )
          )}
          <button
            class="icon"
            title="Edit: open the task's file (its schedule and instructions)"
            aria-label={`Edit ${task.title}`}
            onClick={() => act('edit', task.name)}
          >
            <i class="codicon codicon-edit" />
          </button>
        </span>
      </div>
      <div class="scheduled-line">
        <Status task={task} />
      </div>
      <div class="scheduled-line">
        {last ? (
          <>
            <button class="link scheduled-report" title="Open the report as a page" onClick={() => act('report', task.name, last)}>
              Report of {last}
            </button>
            {earlier.length > 0 && (
              <button class="link scheduled-more" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? 'fewer' : `+${earlier.length} earlier`}
              </button>
            )}
          </>
        ) : (
          <span class="scheduled-none">No report yet</span>
        )}
      </div>
      {last && <RunTickets tickets={task.proposals?.[last]} />}
      {open && (
        <div class="scheduled-reports">
          {earlier.map((day) => (
            <div key={day}>
              <button class="link scheduled-report" onClick={() => act('report', task.name, day)}>
                Report of {day}
              </button>
              <RunTickets tickets={task.proposals?.[day]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What a task's row says at its right: Accept / Dismiss, or what it does next, with Run Now. */
function RowEnd({ task }: { task: ScheduledTaskView }) {
  const stop = (e: Event) => e.stopPropagation();
  if (task.proposed)
    return (
      <span class="scheduled-actions" onClick={stop}>
        <button class="icon" title="Accept the task: it runs on its schedule" aria-label={`Accept ${task.title}`} onClick={() => act('accept', task.name)}>
          <i class="codicon codicon-check" />
        </button>
        <button class="icon" title="Dismiss the task: its file is deleted" aria-label={`Dismiss ${task.title}`} onClick={() => act('dismiss', task.name)}>
          <i class="codicon codicon-close" />
        </button>
      </span>
    );
  if (task.error) return <span class="scheduled-when error">error</span>;
  const label = task.running ? 'running…' : task.paused ? 'paused' : task.due ? 'due' : task.next ? soon(task.next) : 'not again';
  return (
    <span class="scheduled-actions" onClick={stop}>
      <span class={`scheduled-when${task.due && !task.running ? ' waiting' : ''}`} title={task.next ? `Next: ${when(task.next)}` : undefined}>
        {label}
      </span>
      <button
        class="icon"
        title="Run Now: its agent starts at once, if an agent slot is free"
        aria-label={`Run ${task.title} now`}
        disabled={task.running}
        onClick={() => act('run', task.name)}
      >
        <i class="codicon codicon-play" />
      </button>
    </span>
  );
}

/** The rows opened, kept while the view lives: a card stays open after a visit to another tool. */
const openRows = new Set<string>();

/** A task's row in the lane; clicking it opens its full card (status, reports, Edit) under it. */
function TaskRow({ task }: { task: ScheduledTaskView }) {
  const [open, setOpenState] = useState(openRows.has(task.name));
  const setOpen = (on: boolean) => {
    if (on) openRows.add(task.name);
    else openRows.delete(task.name);
    setOpenState(on);
  };
  const icon = task.error ? 'warning' : task.proposed ? 'lightbulb' : task.running ? 'loading codicon-modifier-spin' : 'clock';
  return (
    <div class={`scheduled-item${open ? ' is-open' : ''}`} data-task={task.name}>
      <div class="row scheduled-row" role="button" aria-expanded={open} title={task.schedule} onClick={() => setOpen(!open)}>
        <i class={`codicon codicon-${icon}`} />
        <span class="name">{task.title}</span>
        <RowEnd task={task} />
      </div>
      {open && <TaskCard task={task} />}
    </div>
  );
}

/**
 * The board's Scheduled lane (BL-283), after Discussions: a row per task in .flotilla/backlog/schedules/, proposed
 * ones first, each with what it does next and Run Now (or Accept / Dismiss); a row opens the task's card. Hidden with
 * no tasks.
 */
export function ScheduledLane({ view }: { view?: ScheduledView }) {
  if (!view?.tasks.length) return null;
  const tasks = [...view.tasks].sort((a, b) => Number(!!b.proposed) - Number(!!a.proposed));
  return (
    <div class="group lane scheduled-lane">
      <div class="row group-head">
        <span class="name">Scheduled</span>
        <button
          class="icon"
          title="New Scheduled Task: its name, when it runs and what its agent does"
          aria-label="New scheduled task"
          onClick={() => act('new')}
        >
          <i class="codicon codicon-add" />
        </button>
        <button class="icon" title={`Open the tasks' folder: ${view.dir}`} aria-label="Open the tasks' folder" onClick={() => act('folder')}>
          <i class="codicon codicon-folder-opened" />
        </button>
        <span class="badge">{tasks.length}</span>
      </div>
      <div class="lane-body">
        {tasks.map((t) => (
          <TaskRow key={t.name} task={t} />
        ))}
      </div>
    </div>
  );
}
