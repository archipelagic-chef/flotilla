import { useEffect, useState } from 'preact/hooks';
import { ciWord, latestCi, tookLabel } from '../../features/ci/summary';
import type { TicketCiView, TicketWebviewMessage } from '../ticketProtocol';
import { CiRunList, STATUS, type CiActions } from '../ui/ciList';
import './ci.css';

/**
 * The ticket's CI (BL-106), under its state and Merge to main: a line per worktree whose branch has CI (the latest run,
 * its state and the time it's taken), which opens to the runs as the CI/CD view lists them (the same list, with its
 * jobs, steps, logs and actions). Nothing shows for a branch without CI. Whether it's open is kept per ticket.
 */
export function TicketCi({ ci, send }: { ci: TicketCiView | undefined; send: (message: TicketWebviewMessage) => void }) {
  // The click shows at once; the host keeps it, and says so with the next view.
  const [open, setOpen] = useState<boolean>();
  useEffect(() => setOpen(undefined), [ci?.open]);
  const shown = (ci?.worktrees ?? []).flatMap((w) => {
    const latest = latestCi(w.view);
    return latest && w.view?.kind === 'runs' ? [{ ...w, runs: w.view.runs, latest }] : [];
  });
  const going = shown.some((w) => w.latest.run.status === 'queued' || w.latest.run.status === 'running');
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
      {shown.map(({ key, branch, runs, latest }) => {
        const { run, took } = latest;
        const status = STATUS[run.status];
        return (
          <div key={key} class="ci-worktree">
            <div class={`ci-line ${run.status}`}>
              <button class="ci-summary" aria-expanded={isOpen} onClick={toggle} title={isOpen ? 'Hide the runs' : 'Show the runs and their jobs'}>
                <i class={`codicon codicon-chevron-${isOpen ? 'down' : 'right'} ci-toggle`} />
                <i class={`codicon codicon-${status.icon} ci-status ${run.status}`} aria-label={status.label} />
                <strong>CI {ciWord(run.status)}</strong>
                <span class="muted">
                  {run.workflow} #{run.number} · {tookLabel(took)}
                </span>
                {shown.length > 1 && <span class="ci-branch">{branch}</span>}
              </button>
              <button
                class="icon-button"
                title="Show it in the CI/CD view"
                aria-label="Show it in the CI/CD view"
                onClick={() => send({ type: 'ciShow', key })}
              >
                <i class="codicon codicon-layout-sidebar-left" />
              </button>
              <button class="icon-button" title="Open the run on GitHub" aria-label="Open the run on GitHub" onClick={() => actions.openUrl(run.url)}>
                <i class="codicon codicon-link-external" />
              </button>
            </div>
            {isOpen && (
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
