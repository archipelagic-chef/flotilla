import { conflictRegions } from '../../core/git/conflictRegions';
import type { CiStop } from '../backlog/ciStop';
import type { MergeTrain } from '../backlog/mergeTrain';
import { trainOnto } from '../backlog/mergeTrain';
import { recordEvent } from './events';

/**
 * Records a merge's conflicts (BL-157) with their regions, measured in memory (merge-tree) without holding up the
 * merge: the files git named, with no regions, when that fails.
 */
export function recordConflicts(ticket: string, cwd: string, ours: string, theirs: string, files: readonly string[]): void {
  void conflictRegions(cwd, ours, theirs)
    .catch(() => [])
    .then((found) => recordEvent('merge-conflicted', { ticket, data: { files: found.length ? found : files.map((file) => ({ file, regions: [] })) } }));
}

/**
 * Records the conflicts of a merge train just built (BL-168): its entries that conflict now and didn't, at the same tip,
 * in the train it replaces. Each is measured onto the train's commit before it.
 */
export function recordTrainConflicts(cwd: string, train: MergeTrain, was: MergeTrain | undefined): void {
  for (const e of train.entries) {
    if (!e.conflicts) continue;
    const old = was?.entries.find((o) => o.id === e.id);
    if (old?.conflicts && old.tip === e.tip) continue;
    const onto = trainOnto(train, e.id);
    if (onto) recordConflicts(e.id, cwd, onto.commit, e.tip, e.conflicts);
  }
}

/** Records Merge to main stopping on CI (BL-168): failed, with the failed jobs, or main moved on. */
export function recordCiStop(ticket: string, stop: CiStop): void {
  const data = stop.kind === 'failed' ? { reason: stop.kind, branch: stop.branch, jobs: stop.jobs.map((j) => j.name) } : { reason: stop.kind, branch: stop.branch };
  recordEvent('merge-ci-stopped', { ticket, data });
}

/** The test files the checks' output says failed (vitest's "FAIL" lines), each once. */
export function failedTests(output: string): string[] {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const out = new Set<string>();
  for (const m of plain.matchAll(/^\s*FAIL\s+(\S+)(?:\s+>\s+(.+))?$/gm)) out.add(m[2] ? `${m[1]} > ${m[2].trim()}` : m[1]);
  return [...out].slice(0, 50);
}

/** A click is recorded as one that waited when its button worked this long or longer (BL-116). */
export const CLICK_WAIT_MS = 1000;

/** Records a click whose button showed it was working for CLICK_WAIT_MS or longer: which button, and how long. */
export function recordClickWait(button: string, clicked: number, ticket?: string, now = Date.now()): void {
  const ms = now - clicked;
  if (ms >= CLICK_WAIT_MS) recordEvent('click-waited', { ticket, data: { button, ms } });
}
