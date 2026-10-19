import type { CiRunView, CiView } from '../../webview/protocol';
import type { CiStatus } from './githubActions';

/** Plain words for a state, as the sidebar says them. */
const WORD: Record<CiStatus, string> = {
  queued: 'queued',
  running: 'running',
  success: 'passed',
  failure: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  neutral: 'neutral',
};

/** The worst of some statuses, first in this order: failure, then running, queued, cancelled, success. */
export function worstStatus(statuses: readonly CiStatus[]): CiStatus | undefined {
  return WORST_FIRST.find((s) => statuses.includes(s));
}

const WORST_FIRST: CiStatus[] = ['failure', 'running', 'queued', 'cancelled', 'success', 'neutral', 'skipped'];

/** The latest run of each workflow (runs are newest first). */
function latestPerWorkflow(runs: readonly CiRunView[]): CiRunView[] {
  const latest = new Map<string, CiRunView>();
  for (const r of runs) if (!latest.has(r.workflow)) latest.set(r.workflow, r);
  return [...latest.values()];
}

/** A branch's state: the worst of its workflows' latest runs. Undefined when there are no runs to say. */
export function ciState(view: CiView | undefined): CiStatus | undefined {
  return view?.kind === 'runs' ? worstStatus(latestPerWorkflow(view.runs).map((r) => r.status)) : undefined;
}

/** The workflows whose latest run failed. */
export function failedWorkflows(view: CiView | undefined): string[] {
  return view?.kind === 'runs' ? latestPerWorkflow(view.runs).filter((r) => r.status === 'failure').map((r) => r.workflow) : [];
}

/** One line for a branch's CI: its state and the workflows that failed, or why there is no state. */
export function ciSummary(view: CiView | undefined): string {
  switch (view?.kind) {
    case undefined:
      return '';
    case 'signIn':
      return 'Sign in to GitHub to see its CI.';
    case 'unpublished':
      return 'Publish this branch to run its CI.';
    case 'unsupported':
      return 'CI/CD supports GitHub Actions only for now.';
    case 'error':
      return view.error;
    case 'runs': {
      const state = ciState(view);
      if (!state) return 'No runs for this branch yet.';
      const failed = failedWorkflows(view);
      return `CI ${WORD[state]}${failed.length ? `: ${failed.join(', ')}` : ''}`;
    }
  }
}

/** The state of a scope: one worktree's, or the worst of several (the All tab's). */
export function scopeState(views: ReadonlyArray<CiView | undefined>): CiStatus | undefined {
  return worstStatus(views.map(ciState).filter((s): s is CiStatus => s !== undefined));
}

/** One line for a scope's CI (the All tab: the worst state, and the workflows that failed in any worktree). */
export function scopeSummary(views: ReadonlyArray<CiView | undefined>): string {
  const state = scopeState(views);
  if (!state) return '';
  const failed = state === 'failure' ? [...new Set(views.flatMap(failedWorkflows))] : [];
  return `CI ${WORD[state]}${failed.length ? `: ${failed.join(', ')}` : ''}`;
}

/** The latest run of a branch (of its pushed head), as a ticket's CI line says it (BL-106). */
export interface LatestCi {
  run: CiRunView;
  /** How long it has taken: from its start to its last update, or to now while it's queued or running. Milliseconds. */
  took: number;
}

/** The branch's latest run (GitHub lists runs newest first) and its time. Undefined when there's no CI to show. */
export function latestCi(view: CiView | undefined, now = Date.now()): LatestCi | undefined {
  const run = view?.kind === 'runs' ? view.runs[0] : undefined;
  if (!run) return undefined;
  const start = Date.parse(run.started ?? run.created);
  const end = run.status === 'queued' || run.status === 'running' ? now : Date.parse(run.updated ?? run.started ?? run.created);
  return { run, took: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0 };
}

/** A run's duration as the CI line says it: "45s", "3m 07s", "1h 02m". */
export function tookLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A state in plain words ("passed", "failed"), as the CI line says it. */
export const ciWord = (status: CiStatus): string => WORD[status];
