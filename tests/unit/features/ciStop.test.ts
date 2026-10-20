import { describe, expect, it } from 'vitest';
import { ciMovedPast, type CiStop } from '../../../src/features/backlog/ciStop';

const stop: CiStop = {
  kind: 'failed',
  branch: 'feature/BL-1',
  tip: 'abc',
  runs: [{ id: 7, workflow: 'CI', number: 3, attempt: 1, status: 'failure', url: 'u' }],
  jobs: [],
};
const run = (o: Partial<{ id: number; workflow: string; number: number; attempt: number; status: 'failure' | 'in_progress' | 'success'; sha: string }>) => ({
  id: 7,
  workflow: 'CI',
  number: 3,
  attempt: 1,
  status: 'failure' as const,
  sha: 'abc',
  ...o,
});

describe('ciMovedPast (BL-112)', () => {
  it('holds while the runs on the tip are the ones it stopped on', () => {
    expect(ciMovedPast(stop, [run({}), run({ id: 9, workflow: 'Deploy', number: 1, status: 'success' })])).toBe(false);
    expect(ciMovedPast(stop, [run({ id: 1, number: 2, sha: 'old' })])).toBe(false);
  });

  it('moves past on a re-run, or a later run of the workflow, on the tip', () => {
    expect(ciMovedPast(stop, [run({ attempt: 2, status: 'in_progress' })])).toBe(true);
    expect(ciMovedPast(stop, [run({ status: 'success' })])).toBe(true);
    expect(ciMovedPast(stop, [run({ id: 8, number: 4, status: 'in_progress' })])).toBe(true);
  });

  it('never for main having moved on: only the branch moving ends that', () => {
    expect(ciMovedPast({ kind: 'moved', branch: 'b', base: 'main', tip: 'abc' }, [run({ status: 'success' })])).toBe(false);
  });
});
