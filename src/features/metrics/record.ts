import { conflictRegions } from '../../core/git/conflictRegions';
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
