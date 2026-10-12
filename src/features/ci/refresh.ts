import type { Workstream } from '../workstreams/workstream';
import { isActive, type CiRun, type CiStatus } from './githubActions';

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
