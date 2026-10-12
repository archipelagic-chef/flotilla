import { isActive } from '../../features/ci/githubActions';
import { runActions, type RunAction } from '../../features/ci/runActions';
import type { CiRunView, CiView } from '../protocol';
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

/** Each action's icon and name, on the run's row (shown on hover, like the other row actions). */
const ACTIONS: Record<RunAction, { icon: string; label: string }> = {
  rerun: { icon: 'debug-rerun', label: 'Re-run' },
  rerunFailed: { icon: 'run-errors', label: 'Re-run Failed Jobs' },
  cancel: { icon: 'debug-stop', label: 'Cancel' },
};

/**
 * Version Control › CI/CD: the latest workflow runs of the worktree's branch on GitHub. Runs are read by the extension
 * (see src/ui/ci/ciRuns.ts); a click on one opens it on GitHub. A run's actions (re-run, cancel) go to the extension,
 * which checks them and asks before a cancel.
 */
export function CiBody({ wsKey, view }: { wsKey: string; view: CiView | undefined }) {
  const refresh = () => send({ type: 'ci', op: 'refresh' });
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
          return (
            <div
              key={run.id}
              class={`row log-row ci-run${run.current ? ' current' : ''}`}
              role="button"
              tabIndex={0}
              data-tip={`${run.workflow} #${run.number}: ${status.label}`}
              onClick={() => send({ type: 'openUrl', url: run.url })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send({ type: 'openUrl', url: run.url });
              }}
            >
              <i class={`codicon codicon-${status.icon} ci-status ${run.status}`} aria-label={status.label} />
              <span class="name">
                {run.workflow} #{run.number}
              </span>
              {run.current && <span class="ref" data-tip="The commit checked out in this worktree">checked out</span>}
              <span class="ref">{run.event}</span>
              <span class="desc">{run.title}</span>
              {run.attempt > 1 && <span class="ref" data-tip="This run's re-run attempt">attempt {run.attempt}</span>}
              <span class="ci-age">{ago(run.created)}</span>
              {/* The row's own click and Enter open the run on GitHub: these don't reach it. */}
              <span class="hover-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {runActions({ active: isActive(run.status), failed: run.status === 'failure' }).map((action) => (
                  <button
                    key={action}
                    class="icon"
                    aria-label={ACTIONS[action].label}
                    data-tip={ACTIONS[action].label}
                    onClick={() => send({ type: 'ci', op: 'act', key: wsKey, run: run.id, action })}
                  >
                    <i class={`codicon codicon-${ACTIONS[action].icon}`} />
                  </button>
                ))}
              </span>
            </div>
          );
        })}
    </div>
  );
}
