import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CiJobView, CiRequest, CiRunView, RunBusy } from '../protocol';
import { isActive } from '../../features/ci/githubActions';
import { runActions, type RunAction } from '../../features/ci/runActions';
import { ago } from './ago';
import './ci.css';

/**
 * What the run list asks of the webview it's in (the sidebar's CI/CD view, or a ticket's CI): it sends no message
 * itself, so both can use it, each with its own channel to the extension.
 */
export interface CiActions {
  request(request: CiRequest): void;
  /** Opens a run on GitHub. */
  openUrl(url: string): void;
}

/** Each status's icon and what it says: static icons, no spinner. */
export const STATUS: Record<CiRunView['status'], { icon: string; label: string }> = {
  queued: { icon: 'clock', label: 'Queued' },
  running: { icon: 'circle-large-filled', label: 'Running' },
  success: { icon: 'pass', label: 'Succeeded' },
  failure: { icon: 'error', label: 'Failed' },
  cancelled: { icon: 'circle-slash', label: 'Cancelled' },
  skipped: { icon: 'arrow-right', label: 'Skipped' },
  neutral: { icon: 'circle-large-outline', label: 'Neutral' },
};

/** Each action's icon and name, on the run's row (shown on hover, like the other row actions). */
const ACTIONS: Record<RunAction, { icon: string; label: string }> = {
  rerun: { icon: 'debug-rerun', label: 'Re-run' },
  rerunFailed: { icon: 'run-errors', label: 'Re-run Failed Jobs' },
  cancel: { icon: 'debug-stop', label: 'Cancel' },
};

/**
 * A worktree's runs (BL-3, BL-4): a click on one opens it on GitHub. A run expands to its jobs, a job to its steps, and
 * a job's log opens in an editor; a failed job offers Fix with Agent (BL-7). A failed run opens with its failed jobs
 * expanded. A run's actions (re-run, cancel) go to the extension, which checks them and asks before a cancel.
 */
export function CiRunList({ runs, worktree, actions }: { runs: CiRunView[]; worktree: string; actions: CiActions }) {
  // Which runs and jobs are expanded ("run:7", "job:9"). Failed ones are opened once, when they first show as failed.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const opened = useRef(new Set<string>());
  useEffect(() => {
    const auto: string[] = [];
    for (const run of runs) {
      if (run.status === 'failure' && !opened.current.has(`run:${run.id}`)) auto.push(`run:${run.id}`);
      for (const job of run.jobs ?? []) if (job.status === 'failure' && !opened.current.has(`job:${job.id}`)) auto.push(`job:${job.id}`);
    }
    if (!auto.length) return;
    for (const key of auto) opened.current.add(key);
    setOpen((current) => new Set([...current, ...auto]));
    for (const run of runs) if (auto.includes(`run:${run.id}`)) actions.request({ op: 'expand', key: worktree, runId: run.id });
  }, [runs, worktree]);
  const toggleRun = (runId: number) => {
    const key = `run:${runId}`;
    const expand = !open.has(key);
    setOpen((current) => {
      const next = new Set(current);
      if (expand) next.add(key);
      else next.delete(key);
      return next;
    });
    actions.request({ op: expand ? 'expand' : 'collapse', key: worktree, runId });
  };
  const toggleJob = (jobId: number) => {
    const key = `job:${jobId}`;
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <>
      {runs.map((run) => {
        const status = STATUS[run.status];
        const isOpen = open.has(`run:${run.id}`);
        return (
          <Fragment key={run.id}>
            <div
              class={`row log-row ci-run ${run.status}${run.current ? ' current' : ''}`}
              role="button"
              tabIndex={0}
              data-tip={`${run.workflow} #${run.number}: ${status.label}`}
              onClick={() => actions.openUrl(run.url)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') actions.openUrl(run.url);
              }}
            >
              <button
                class="icon ci-toggle"
                aria-expanded={isOpen}
                aria-label={isOpen ? 'Collapse the jobs' : 'Expand to the jobs'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRun(run.id);
                }}
              >
                <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'}`} />
              </button>
              <i class={`codicon codicon-${status.icon} ci-status ${run.status}`} aria-label={status.label} />
              <span class="name">
                {run.workflow} #{run.number}
              </span>
              {run.current && (
                <span class="ref" data-tip="The commit checked out in this worktree">
                  checked out
                </span>
              )}
              <span class="ref">{run.event}</span>
              <span class="desc">{run.title}</span>
              {run.attempt > 1 && (
                <span class="ref" data-tip="This run's re-run attempt">
                  attempt {run.attempt}
                </span>
              )}
              <span class="ci-age">{ago(run.created)}</span>
              {/* The row's own click and Enter open the run on GitHub: these don't reach it. */}
              <span class="hover-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {runActions({ active: isActive(run.status), failed: run.status === 'failure' }).map((action) => (
                  <button
                    key={action}
                    class="icon"
                    aria-label={ACTIONS[action].label}
                    data-tip={ACTIONS[action].label}
                    disabled={!!run.busy}
                    aria-busy={run.busy === action}
                    onClick={() => actions.request({ op: 'act', key: worktree, run: run.id, action })}
                  >
                    <i class={`codicon codicon-${run.busy === action ? 'loading codicon-modifier-spin' : ACTIONS[action].icon}`} />
                  </button>
                ))}
              </span>
            </div>
            {isOpen && <Jobs run={run} worktree={worktree} open={open} onJob={toggleJob} actions={actions} />}
          </Fragment>
        );
      })}
    </>
  );
}

/** A run's jobs (or why they aren't there), each with its steps when expanded. */
function Jobs({ run, worktree, open, onJob, actions }: { run: CiRunView; worktree: string; open: ReadonlySet<string>; onJob: (jobId: number) => void; actions: CiActions }) {
  if (run.jobsError) return <div class="row group-empty error ci-indent">{run.jobsError}</div>;
  if (!run.jobs) return <div class="row group-empty ci-indent">Loading jobs…</div>;
  if (!run.jobs.length) return <div class="row group-empty ci-indent">No jobs in this run.</div>;
  return (
    <>
      {run.jobs.map((job) => (
        <JobRow key={job.id} job={job} run={run.id} busy={run.busy} worktree={worktree} isOpen={open.has(`job:${job.id}`)} onToggle={() => onJob(job.id)} actions={actions} />
      ))}
    </>
  );
}

function JobRow({ job, run, busy, worktree, isOpen, onToggle, actions }: { job: CiJobView; run: number; busy?: RunBusy; worktree: string; isOpen: boolean; onToggle: () => void; actions: CiActions }) {
  const status = STATUS[job.status];
  return (
    <>
      <div
        class={`row log-row ci-job ${job.status}`}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        data-tip={`${job.name}: ${status.label}`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onToggle();
        }}
      >
        <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'} ci-toggle`} />
        <i class={`codicon codicon-${status.icon} ci-status ${job.status}`} aria-label={status.label} />
        <span class="name">{job.name}</span>
        {job.status === 'failure' && (
          <button
            class="link ci-fix"
            data-tip="Start an agent on this job's failure, in the branch's worktree"
            disabled={!!busy}
            aria-busy={busy === 'fix'}
            onClick={(e) => {
              e.stopPropagation();
              actions.request({ op: 'fix', key: worktree, run, job: job.id });
            }}
          >
            {busy === 'fix' && <i class="codicon codicon-loading codicon-modifier-spin" />}
            {busy === 'fix' ? 'Starting Agent…' : 'Fix with Agent'}
          </button>
        )}
        <button
          class="link ci-log"
          onClick={(e) => {
            e.stopPropagation();
            actions.request({ op: 'showLog', key: worktree, jobId: job.id, jobName: job.name });
          }}
        >
          Show Log
        </button>
      </div>
      {isOpen &&
        job.steps.map((step) => {
          const stepStatus = STATUS[step.status];
          return (
            <div key={step.number} class={`row log-row ci-step ${step.status}`} data-tip={`${step.name}: ${stepStatus.label}`}>
              <i class={`codicon codicon-${stepStatus.icon} ci-status ${step.status}`} aria-label={stepStatus.label} />
              <span class="name">{step.name}</span>
            </div>
          );
        })}
    </>
  );
}
