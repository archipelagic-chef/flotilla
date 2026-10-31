import { useState } from 'preact/hooks';
import type {
  ScheduledOp,
  ScheduledTaskView,
  ScheduledView,
} from '../scheduledProtocol';
import { send } from './api';
import './scheduled.css';

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
  if (task.due)
    return (
      <span class="scheduled-status waiting" title={task.waits ? 'Due: it starts once that no longer holds it' : 'Due: it starts within a few minutes'}>
        <i class="codicon codicon-clock" /> Due{task.waits ? `, waits: ${task.waits}` : ''}
      </span>
    );
  return <span class="scheduled-status">{task.next ? `Next: ${when(task.next)}` : 'Ran: not again'}</span>;
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
              <button
                class="icon"
                title="Run Now: its agent starts at once, if an agent slot is free"
                aria-label={`Run ${task.title} now`}
                disabled={task.running}
                onClick={() => act('run', task.name)}
              >
                <i class="codicon codicon-play" />
              </button>
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
      {open && (
        <div class="scheduled-reports">
          {earlier.map((day) => (
            <button key={day} class="link scheduled-report" onClick={() => act('report', task.name, day)}>
              Report of {day}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Scheduled tool (BL-260): every task in .flotilla/backlog/schedules/, proposed ones first, each with when it runs
 * next (or what it waits for), its reports, Run Now and Edit.
 */
export function ScheduledBody({ view }: { view?: ScheduledView }) {
  if (!view) return <div class="empty">Loading the scheduled tasks…</div>;
  const tasks = [...view.tasks].sort((a, b) => Number(!!b.proposed) - Number(!!a.proposed));
  return (
    <div class="scheduled">
      {tasks.length ? (
        tasks.map((t) => <TaskCard key={t.name} task={t} />)
      ) : (
        <div class="empty">
          No scheduled tasks yet. A task is a Markdown file in {view.dir}: an <code>every:</code> or <code>once:</code> line in its front matter, and what its
          agent does.
        </div>
      )}
      <div class="scheduled-foot">
        <button class="link" title={view.dir} onClick={() => act('folder')}>
          Open the tasks' folder
        </button>
      </div>
    </div>
  );
}
