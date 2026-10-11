import type { CiStatus } from './githubActions';
import type { CiView } from './ciWatcher';

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

/** One line for a branch's CI: its state and the workflows that failed, or why there's no state. */
export function ciSummary(view: CiView | undefined): string {
  if (!view) return '';
  if (!view.state) return view.note ?? 'No CI runs yet.';
  const failed = view.failed.length ? `: ${view.failed.join(', ')}` : '';
  return `CI ${WORD[view.state]}${failed}`;
}

/** The worst of some statuses, first in this order: failure, then running, queued, cancelled, success. */
export function worstStatus(statuses: readonly CiStatus[]): CiStatus | undefined {
  return WORST_FIRST.find((s) => statuses.includes(s));
}

const WORST_FIRST: CiStatus[] = ['failure', 'running', 'queued', 'cancelled', 'success', 'neutral', 'skipped'];

/** The state of a scope: one worktree's, or the worst of several (the All tab's). */
export function scopeState(views: ReadonlyArray<CiView | undefined>): CiStatus | undefined {
  return worstStatus(views.map((v) => v?.state).filter((s): s is CiStatus => s !== undefined));
}
