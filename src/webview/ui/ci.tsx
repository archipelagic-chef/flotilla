import type { CiView } from '../protocol';
import type { CiDeployment, DeploymentState } from '../../features/ci/githubDeployments';
import { send } from './api';
import { ago } from './ago';
import { CiRunList, type CiActions } from './ciList';

/** The run list's requests, from the sidebar. */
const ACTIONS: CiActions = {
  request: (request) => send({ type: 'ci', ...request }),
  openUrl: (url) => send({ type: 'openUrl', url }),
};

/** Each deployment state's icon and what it says; css is the class the colors go by (as the runs' are). */
const DEPLOYMENT: Record<DeploymentState, { icon: string; label: string; css: string }> = {
  success: { icon: 'pass', label: 'Success', css: 'success' },
  failure: { icon: 'error', label: 'Failure', css: 'failure' },
  in_progress: { icon: 'circle-large-filled', label: 'In progress', css: 'running' },
  inactive: { icon: 'circle-slash', label: 'Inactive', css: 'neutral' },
};

/**
 * Version Control › CI/CD: the latest workflow runs of the worktree's branch on GitHub, then its deployments (the latest
 * per environment; no group when there are none). Both are read by the extension
 * (see src/ui/ci/ciRuns.ts); a click on one opens it on GitHub. The runs are the list a ticket shows too (CiRunList).
 */
export function CiBody({ view, worktree }: { view: CiView | undefined; worktree: string }) {
  const refresh = () => send({ type: 'ci', op: 'refresh' });
  const deployments = view?.kind === 'runs' ? view.deployments : [];
  const deploymentsError = view?.kind === 'runs' ? view.deploymentsError : undefined;
  // What the extension is busy with for this view (BL-119): the buttons spin and take no click until it's done.
  const refreshing = !!view?.busy?.includes('refresh');
  const starting = !!view?.busy?.includes('runWorkflow');
  return (
    <>
      <div class="group ci">
        <div class="row group-head">
          <span class="name">CI/CD</span>
          <span class="hover-actions">
            <button
              class="icon"
              aria-label="Run Workflow…"
              data-tip="Run Workflow… on this branch"
              disabled={starting}
              aria-busy={starting}
              onClick={() => send({ type: 'runWorkflow', key: worktree })}
            >
              <i class={`codicon codicon-${starting ? 'loading codicon-modifier-spin' : 'play'}`} />
            </button>
            <button class="icon" aria-label="Refresh" disabled={refreshing} aria-busy={refreshing} onClick={refresh}>
              <i class={`codicon codicon-${refreshing ? 'loading codicon-modifier-spin' : 'refresh'}`} />
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
        {view?.kind === 'runs' && <CiRunList runs={view.runs} worktree={worktree} actions={ACTIONS} />}
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
              // Only the row's own key: Enter on the site button (inside the row) is the button's, not the row's.
              if (e.key === 'Enter' && e.target === e.currentTarget) send({ type: 'openUrl', url: d.url });
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
