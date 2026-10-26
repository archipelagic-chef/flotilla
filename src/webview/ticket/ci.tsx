import { useEffect, useState } from 'preact/hooks';
import {
  ciWord,
  type LatestCi,
  latestCi,
  tookLabel,
} from '../../features/ci/summary';
import type { CiRunView, CiView } from '../protocol';
import type { TicketCiView, TicketWebviewMessage } from '../ticketProtocol';
import { CiRunList, STATUS, type CiActions } from '../ui/ciList';
import './ci.css';

/**
 * The ticket's CI (BL-106), under its state and Merge to main: a line per worktree whose branch has CI (the latest run,
 * its state and the time it's taken), which opens to the runs as the CI/CD view lists them (the same list, with its
 * jobs, steps, logs and actions). Whether it's open is kept per ticket. A branch in a GitHub repository with workflows
 * shows its line before any run (BL-222), with Run CI (push the branch, or re-run its latest run) and Run Workflow…
 * (a workflow_dispatch one, on the branch). Nothing shows for a branch without CI.
 */
export function TicketCi({ ci, send }: { ci: TicketCiView | undefined; send: (message: TicketWebviewMessage) => void }) {
  // The click shows at once; the host keeps it, and says so with the next view.
  const [open, setOpen] = useState<boolean>();
  useEffect(() => setOpen(undefined), [ci?.open]);
  const shown = (ci?.worktrees ?? []).flatMap((w): Array<typeof w & { view: CiView; runs: CiRunView[]; latest?: LatestCi }> => {
    const view = w.view;
    if (view?.kind === 'runs') return [{ ...w, view, runs: view.runs, latest: latestCi(view) }];
    // Not pushed yet, in a GitHub repository with workflows: Run CI pushes it.
    return view?.kind === 'unpublished' && view.repo ? [{ ...w, view, runs: [], latest: undefined }] : [];
  });
  const going = shown.some((w) => w.latest?.run.status === 'queued' || w.latest?.run.status === 'running');
  // While a run goes on, its time counts up each second (the runs themselves are read every 10 seconds).
  const [, tick] = useState(0);
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [going]);
  if (!ci || !shown.length) return null;
  const isOpen = open ?? ci.open;
  const actions: CiActions = {
    request: (request) => send({ type: 'ci', ...request }),
    openUrl: (href) => send({ type: 'openHref', href }),
  };
  const toggle = () => {
    setOpen(!isOpen);
    send({ type: 'ciOpen', open: !isOpen });
  };
  return (
    <section class={`ci-panel${isOpen ? ' open' : ''}`}>
      {shown.map(({ key, branch, view, runs, latest, ahead, upstream }) => {
        const run = latest?.run;
        const status = run && STATUS[run.status];
        // What Run CI does: the branch isn't on origin, or origin lacks its latest commits, so it's pushed; else its latest run goes again.
        const push = view.kind === 'unpublished' || !upstream || !!ahead;
        const runningCi = !!view.busy?.includes('runCi');
        const starting = !!view.busy?.includes('runWorkflow');
        const runCiTip = push
          ? 'Push the branch to origin, which starts the workflows that run on push'
          : run
            ? `Re-run ${run.workflow} #${run.number}`
            : 'Origin has the branch: no run to re-run yet';
        return (
          <div key={key} class="ci-worktree">
            <div class={`ci-line ${run?.status ?? 'none'}`}>
              {run && status && latest ? (
                <button class="ci-summary" aria-expanded={isOpen} onClick={toggle} title={isOpen ? 'Hide the runs' : 'Show the runs and their jobs'}>
                  <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'} ci-toggle`} />
                  <i class={`codicon codicon-${status.icon} ci-status ${run.status}`} aria-label={status.label} />
                  <strong>CI {ciWord(run.status)}</strong>
                  <span class="muted">
                    {run.workflow} #{run.number} · {tookLabel(latest.took)}
                  </span>
                  {shown.length > 1 && <span class="ci-branch">{branch}</span>}
                </button>
              ) : (
                <span class="ci-summary">
                  <i class="codicon codicon-circle-large-outline ci-status none" aria-hidden="true" />
                  <strong>CI</strong>
                  <span class="muted">{view.kind === 'unpublished' ? 'Not on origin yet' : 'No runs yet'}</span>
                  {shown.length > 1 && <span class="ci-branch">{branch}</span>}
                </span>
              )}
              <button
                class="icon-button ci-run"
                title={runCiTip}
                disabled={runningCi || (!push && !run)}
                aria-busy={runningCi}
                onClick={() => send({ type: 'ci', op: 'runCi', key })}
              >
                <i class={`codicon codicon-${runningCi ? 'loading codicon-modifier-spin' : push ? 'cloud-upload' : 'debug-rerun'}`} />
                Run CI
              </button>
              {view.kind === 'runs' && (
                <button
                  class="icon-button"
                  title="Run Workflow… on this branch: one that can be started by hand"
                  aria-label="Run Workflow…"
                  disabled={starting}
                  aria-busy={starting}
                  onClick={() => send({ type: 'ci', op: 'runWorkflow', key })}
                >
                  <i class={`codicon codicon-${starting ? 'loading codicon-modifier-spin' : 'play'}`} />
                </button>
              )}
              <button
                class="icon-button"
                title="Show it in the CI/CD view"
                aria-label="Show it in the CI/CD view"
                onClick={() => send({ type: 'ciShow', key })}
              >
                <i class="codicon codicon-layout-sidebar-left" />
              </button>
              {run && (
                <button class="icon-button" title="Open the run on GitHub" aria-label="Open the run on GitHub" onClick={() => actions.openUrl(run.url)}>
                  <i class="codicon codicon-link-external" />
                </button>
              )}
            </div>
            {isOpen && runs.length > 0 && (
              <div class="ci-runs">
                <CiRunList runs={runs} worktree={key} actions={actions} />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
