import type { Workstream } from '../workstreams/workstream';
import { isActive, type CiRun, type CiStatus } from './githubActions';
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

/** Whether a run's jobs are read (again): never read, the run still going, or its status moved since they were read. */
export const jobsDue = (status: CiStatus, known: { status: CiStatus } | undefined): boolean => !known || isActive(status) || known.status !== status;

/** Whether any of the runs is still going. */
export const anyRunActive = (runs: readonly CiRun[]): boolean => runs.some((r) => isActive(r.status));

/**
 * A deployment older than this is not waited for: GitHub doesn't end a deployment by itself, so one with no status, or
 * stuck in progress, would keep the 10-second pace for good.
 */
export const DEPLOYMENT_WAIT_MS = 2 * 60 * 60 * 1000;

/**
 * Whether any deployment is still going, and recent enough to wait for (a deploy in progress is read again at the same
 * pace as a run).
 */
export const anyDeploymentActive = (deployments: readonly CiDeployment[], now = Date.now()): boolean =>
  deployments.some((d) => d.state === 'in_progress' && Date.parse(d.created) > now - DEPLOYMENT_WAIT_MS);
