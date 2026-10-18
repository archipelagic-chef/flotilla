import { isActive, type CiRun } from './githubActions';

/** Which finished runs to tell the user about: the failures (default), every one, or none. */
export type CiNotify = 'failures' | 'all' | 'off';

/** A run that finished on a worktree's branch, with the repository it ran in and the worktree (by key). */
export interface FinishedRun {
  key: string;
  repo: string;
  branch: string;
  run: CiRun;
}

/** The runs in now that finished since they were last read while they were going (before). A run that was done already is not news. */
export function finished(before: readonly CiRun[], now: readonly CiRun[]): CiRun[] {
  const going = new Set(before.filter((r) => isActive(r.status)).map((r) => r.id));
  return now.filter((r) => !isActive(r.status) && going.has(r.id));
}

/** Whether a finished run is one to tell the user about under this setting. */
export function notifies(run: CiRun, mode: CiNotify): boolean {
  return mode === 'all' || (mode === 'failures' && run.status === 'failure');
}
