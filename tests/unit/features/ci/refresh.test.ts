import { describe, expect, it } from 'vitest';
import { CI_ACTIVE_INTERVAL_MS, CI_INTERVAL_MS, anyRunActive, ciStamp, jobsDue, refreshDelay } from '../../../../src/features/ci/refresh';
import type { CiRun } from '../../../../src/features/ci/githubActions';

describe('refreshDelay', () => {
  it('reads nothing while the sidebar is hidden', () => {
    expect(refreshDelay(false, false)).toBeUndefined();
    expect(refreshDelay(false, true)).toBeUndefined();
  });

  it('reads every minute while it is visible', () => {
    expect(refreshDelay(true, false)).toBe(60_000);
    expect(CI_INTERVAL_MS).toBe(60_000);
  });

  it('reads every 10 seconds while a run is queued or running', () => {
    expect(refreshDelay(true, true)).toBe(10_000);
    expect(CI_ACTIVE_INTERVAL_MS).toBe(10_000);
  });
});

describe('ciStamp', () => {
  it('changes with the commit checked out and with the upstream, and not with anything else', () => {
    const at = (head: string | undefined, upstream: string | undefined) => ({ sync: { head, upstream, ahead: 0, behind: 0, hasRemote: true } });
    expect(ciStamp(at('a', 'origin/x'))).toBe(ciStamp(at('a', 'origin/x')));
    expect(ciStamp(at('b', 'origin/x'))).not.toBe(ciStamp(at('a', 'origin/x')));
    expect(ciStamp(at('a', 'origin/y'))).not.toBe(ciStamp(at('a', 'origin/x')));
    expect(ciStamp(at(undefined, undefined))).toBe(ciStamp(at('', '')));
  });
});

describe('anyRunActive', () => {
  const run = (status: CiRun['status']) => ({ status }) as CiRun;

  it('is true while a run is queued or running', () => {
    expect(anyRunActive([run('success'), run('queued')])).toBe(true);
    expect(anyRunActive([run('running')])).toBe(true);
  });

  it('is false when every run has finished, or there are none', () => {
    expect(anyRunActive([run('success'), run('failure'), run('cancelled')])).toBe(false);
    expect(anyRunActive([])).toBe(false);
  });
});

describe('jobsDue', () => {
  it('reads a run’s jobs when they were never read', () => {
    expect(jobsDue('success', undefined)).toBe(true);
  });

  it('reads them again while the run goes on, and when its status has moved', () => {
    expect(jobsDue('running', { status: 'running' })).toBe(true);
    expect(jobsDue('queued', { status: 'queued' })).toBe(true);
    expect(jobsDue('success', { status: 'running' })).toBe(true);
  });

  it('does not read a finished run’s jobs again', () => {
    expect(jobsDue('failure', { status: 'failure' })).toBe(false);
  });
});
