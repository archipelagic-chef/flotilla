import type { CiRunView, CiView } from '../protocol';
import type { CiDeployment, DeploymentState } from '../../features/ci/githubDeployments';
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

/** Each deployment state's icon and what it says; css is the class the colors go by (as the runs' are). */
const DEPLOYMENT: Record<DeploymentState, { icon: string; label: string; css: string }> = {
  success: { icon: 'pass', label: 'Success', css: 'success' },
  failure: { icon: 'error', label: 'Failure', css: 'failure' },
  in_progress: { icon: 'circle-large-filled', label: 'In progress', css: 'running' },
  inactive: { icon: 'circle-slash', label: 'Inactive', css: 'neutral' },
};

/**
 * Version Control › CI/CD: the latest workflow runs of the worktree's branch on GitHub, then its deployments: the latest
 * per environment, and no group at all when there are none. Both are read by the extension (see src/ui/ci/ciRuns.ts);
 * a click on a run or a deployment opens it on GitHub, and a deployment's site button opens the deployed site.
 */
export function CiBody({ view }: { view: CiView | undefined }) {
  const refresh = () => send({ type: 'ci', op: 'refresh' });
  const deployments = view?.kind === 'runs' ? view.deployments : [];
  const deploymentsError = view?.kind === 'runs' ? view.deploymentsError : undefined;
  return (
    <>
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
                <span class="ci-age">{ago(run.created)}</span>
              </div>
            );
          })}
      </div>
      {(deployments.length > 0 || deploymentsError) && <DeploymentsGroup deployments={deployments} error={deploymentsError} />}
    </>
  );
}

/** The deployments of the branch, one per environment: the state, the commit and when; the site opens from its button. */
function DeploymentsGroup({ deployments, error }: { deployments: CiDeployment[]; error?: string }) {
  return (
    <div class="group ci deployments">
      <div class="row group-head">
        <span class="name">Deployments</span>
      </div>
      {error && <div class="row group-empty error">{error}</div>}
      {deployments.map((d) => {
        const state = DEPLOYMENT[d.state];
        return (
          <div
            key={d.id}
            class="row log-row ci-run"
            role="button"
            tabIndex={0}
            data-tip={`${d.environment}: ${state.label}`}
            onClick={() => send({ type: 'openUrl', url: d.url })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send({ type: 'openUrl', url: d.url });
            }}
          >
            <i class={`codicon codicon-${state.icon} ci-status ${state.css}`} aria-label={state.label} />
            <span class="name">{d.environment}</span>
            <span class="ref">{d.sha.slice(0, 7)}</span>
            <span class="desc">{state.label}</span>
            <span class="ci-age">{ago(d.created)}</span>
            {d.siteUrl && (
              <button
                class="icon"
                aria-label="Open the site"
                data-tip="Open the deployed site"
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: 'openSite', url: d.siteUrl! });
                }}
              >
                <i class="codicon codicon-globe" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
