import { describe, expect, it } from 'vitest';
import { finished, notifies } from '../../../../src/features/ci/notify';
import type { CiRun } from '../../../../src/features/ci/githubActions';

const run = (id: number, status: CiRun['status']): CiRun => ({
  id,
  workflow: 'CI',
  number: id,
  title: 'A commit',
  event: 'push',
  status,
  url: `https://github.com/acme/app/actions/runs/${id}`,
  sha: 'abc',
  attempt: 1,
  created: '2026-10-11T10:00:00Z',
});

describe('finished', () => {
  it('lists the runs that were going and are done now, not the ones that were done already', () => {
    const before = [run(1, 'running'), run(2, 'success')];
    const now = [run(1, 'failure'), run(2, 'success'), run(3, 'success')];
    expect(finished(before, now).map((r) => [r.id, r.status])).toEqual([[1, 'failure']]);
  });

  it('is quiet when there was nothing read before (start-up) or the run is still going', () => {
    expect(finished([], [run(1, 'failure')])).toEqual([]);
    expect(finished([run(1, 'queued')], [run(1, 'running')])).toEqual([]);
  });
});

describe('notifies', () => {
  it('tells about failures by default, every finished run with all, and nothing when off', () => {
    expect([notifies(run(1, 'success'), 'failures'), notifies(run(2, 'failure'), 'failures')]).toEqual([false, true]);
    expect([notifies(run(1, 'success'), 'all'), notifies(run(2, 'failure'), 'all')]).toEqual([true, true]);
    expect([notifies(run(1, 'success'), 'off'), notifies(run(2, 'failure'), 'off')]).toEqual([false, false]);
  });
});
