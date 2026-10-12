import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CiJobView, CiRunView, CiView } from '../protocol';
import { send } from './api';
import { ago } from './vc';

/** Each status's icon and what it says: static icons, no spinner. */
const STATUS: Record<CiRunView['status'], { icon: string; label: string }> = {
  queued: { icon: 'clock', label: 'Queued' },
  running: { icon: 'circle-large-filled', label: 'Running' },
  success: { icon: 'pass', label: 'Succeeded' },
  failure: { icon: 'error', label: 'Failed' },
  cancelled: { icon: 'circle-slash', label: 'Cancelled' },
  skipped: { icon: 'arrow-right', label: 'Skipped' },
  neutral: { icon: 'circle-large-outline', label: 'Neutral' },
};

/**
 * Version Control › CI/CD: the latest workflow runs of the worktree's branch on GitHub. Runs are read by the extension
 * (see src/ui/ci/ciRuns.ts); a click on one opens it on GitHub. A run expands to its jobs, a job to its steps, and a
 * job's log opens in an editor. A failed run opens with its failed jobs expanded.
 */
export function CiBody({ view, worktree }: { view: CiView | undefined; worktree: string }) {
  const refresh = () => send({ type: 'ci', op: 'refresh' });
  // Which runs and jobs are expanded ("run:7", "job:9"). Failed ones are opened once, when they first show as failed.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const opened = useRef(new Set<string>());
  useEffect(() => {
    if (view?.kind !== 'runs') return;
    const auto: string[] = [];
    for (const run of view.runs) {
      if (run.status === 'failure' && !opened.current.has(`run:${run.id}`)) auto.push(`run:${run.id}`);
      for (const job of run.jobs ?? []) if (job.status === 'failure' && !opened.current.has(`job:${job.id}`)) auto.push(`job:${job.id}`);
    }
    if (!auto.length) return;
    for (const key of auto) opened.current.add(key);
    setOpen((current) => new Set([...current, ...auto]));
    for (const run of view.runs) if (auto.includes(`run:${run.id}`)) send({ type: 'ci', op: 'expand', key: worktree, runId: run.id });
  }, [view, worktree]);
  const toggleRun = (runId: number) => {
    const key = `run:${runId}`;
    const expand = !open.has(key);
    setOpen((current) => {
      const next = new Set(current);
      if (expand) next.add(key);
      else next.delete(key);
      return next;
    });
    send({ type: 'ci', op: expand ? 'expand' : 'collapse', key: worktree, runId });
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
    <div class="group ci">
      <div class="row group-head">
        <span class="name">CI/CD</span>
        <span class="hover-actions">
          <button class="icon" aria-label="Refresh" onClick={refresh}>
            <i class="codicon codicon-refresh" />
          </button>
        </span>
        {view?.kind === 'runs' && <span class="desc ci-repo">{view.repo}</span>}
      </div>
      {!view && <div class="row group-empty">Loading…</div>}
      {view?.kind === 'signIn' && (
        <div class="row group-empty">
          <button class="link" onClick={() => send({ type: 'ci', op: 'signIn' })}>
            Sign in to GitHub
          </button>
        </div>
      )}
      {view?.kind === 'unpublished' && <div class="row group-empty">Publish this branch to run its CI.</div>}
      {view?.kind === 'unsupported' && <div class="row group-empty">CI/CD supports GitHub Actions only for now.</div>}
      {view?.kind === 'error' && <div class="row group-empty error">{view.error}</div>}
      {view?.kind === 'runs' && !view.runs.length && <div class="row group-empty">No runs for {view.branch} yet.</div>}
      {view?.kind === 'runs' &&
        view.runs.map((run) => {
          const status = STATUS[run.status];
          const isOpen = open.has(`run:${run.id}`);
          return (
            <Fragment key={run.id}>
              <div
                class={`row log-row ci-run ${run.status}${run.current ? ' current' : ''}`}
                role="button"
                tabIndex={0}
                data-tip={`${run.workflow} #${run.number}: ${status.label}`}
                onClick={() => send({ type: 'openUrl', url: run.url })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') send({ type: 'openUrl', url: run.url });
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
                {run.current && <span class="ref" data-tip="The commit checked out in this worktree">checked out</span>}
                <span class="ref">{run.event}</span>
                <span class="desc">{run.title}</span>
                <span class="ci-age">{ago(run.created)}</span>
              </div>
              {isOpen && <Jobs run={run} worktree={worktree} open={open} onJob={toggleJob} />}
            </Fragment>
          );
        })}
    </div>
  );
}

/** A run's jobs (or why they aren't there), each with its steps when expanded. */
function Jobs({ run, worktree, open, onJob }: { run: CiRunView; worktree: string; open: ReadonlySet<string>; onJob: (jobId: number) => void }) {
  if (run.jobsError) return <div class="row group-empty error ci-indent">{run.jobsError}</div>;
  if (!run.jobs) return <div class="row group-empty ci-indent">Loading jobs…</div>;
  if (!run.jobs.length) return <div class="row group-empty ci-indent">No jobs in this run.</div>;
  return (
    <>
      {run.jobs.map((job) => (
        <JobRow key={job.id} job={job} worktree={worktree} isOpen={open.has(`job:${job.id}`)} onToggle={() => onJob(job.id)} />
      ))}
    </>
  );
}

function JobRow({ job, worktree, isOpen, onToggle }: { job: CiJobView; worktree: string; isOpen: boolean; onToggle: () => void }) {
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
        <button
          class="link ci-log"
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'ci', op: 'showLog', key: worktree, jobId: job.id, jobName: job.name });
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
