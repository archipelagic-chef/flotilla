import type { CiRun, CiStatus } from '../ci/githubActions';
import type { CiDecision } from './mergeCi';

/**
 * Why Merge to main last stopped on CI (BL-112), for the ticket to say by its button: red CI with the failed jobs, or
 * the base having moved on. It holds while the branch is at tip and CI's runs on it are these.
 */
export type CiStop =
  | {
      kind: 'failed';
      branch: string;
      tip: string;
      runs: Array<Pick<CiRun, 'id' | 'workflow' | 'number' | 'attempt' | 'status' | 'url'>>;
      jobs: Array<{
        runId: number;
        jobId: number;
        name: string;
        url: string;
        status: CiStatus;
      }>;
    }
  | { kind: 'moved'; branch: string; base: string; tip: string };

/** The stop a decision makes, if it's one. */
export function ciStop(d: CiDecision, branch: string, base: string): CiStop | undefined {
  if (d.kind === 'moved') return { kind: 'moved', branch, base, tip: d.tip };
  if (d.kind !== 'failed') return undefined;
  return {
    kind: 'failed',
    branch,
    tip: d.tip,
    runs: d.runs.map((r) => ({
      id: r.id,
      workflow: r.workflow,
      number: r.number,
      attempt: r.attempt,
      status: r.status,
      url: r.url,
    })),
    jobs: d.jobs.map((f) => ({
      runId: f.run.id,
      jobId: f.job.id,
      name: f.job.name,
      url: f.job.url,
      status: f.job.status,
    })),
  };
}

/**
 * Whether CI moved past a red stop: runs on its tip read since (a re-run, a later run of the workflow) aren't the ones
 * it stopped on.
 */
export function ciMovedPast(stop: CiStop, runs: ReadonlyArray<Pick<CiRun, 'id' | 'workflow' | 'number' | 'attempt' | 'status' | 'sha'>>): boolean {
  if (stop.kind !== 'failed') return false;
  return runs.some((r) => {
    if (r.sha !== stop.tip) return false;
    const was = stop.runs.find((s) => s.workflow === r.workflow);
    if (!was) return false;
    return r.id === was.id ? r.attempt !== was.attempt || r.status !== was.status : r.number > was.number;
  });
}
