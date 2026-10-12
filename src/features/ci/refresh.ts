import type { Workstream } from '../workstreams/workstream';
import { isActive, type CiRun } from './githubActions';
import type { CiDeployment } from './githubDeployments';

/** The CI/CD view looks again every minute while the sidebar is visible… */
export const CI_INTERVAL_MS = 60_000;
/** …and every 10 seconds while a run is queued or running. */
export const CI_ACTIVE_INTERVAL_MS = 10_000;

/** When to read the runs again: nothing while the sidebar is hidden. */
export function refreshDelay(visible: boolean, anyActive: boolean): number | undefined {
  if (!visible) return undefined;
  return anyActive ? CI_ACTIVE_INTERVAL_MS : CI_INTERVAL_MS;
}

/** What a worktree's runs depend on: the commit checked out and the upstream. A change means they're read at once (a push). */
export const ciStamp = (ws: Pick<Workstream, 'sync'>): string => `${ws.sync.head ?? ''}\n${ws.sync.upstream ?? ''}`;

/** Whether any of the runs is still going. */
export const anyRunActive = (runs: readonly CiRun[]): boolean => runs.some((r) => isActive(r.status));

/** Whether any deployment is still going (a deploy that is in progress is read again at the same pace as a run). */
export const anyDeploymentActive = (deployments: readonly CiDeployment[]): boolean => deployments.some((d) => d.state === 'in_progress');
