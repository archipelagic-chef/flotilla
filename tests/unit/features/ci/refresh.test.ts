import { describe, expect, it } from 'vitest';
import { CI_ACTIVE_INTERVAL_MS, CI_INTERVAL_MS, anyDeploymentActive, anyRunActive, ciStamp, refreshDelay } from '../../../../src/features/ci/refresh';
import type { CiDeployment } from '../../../../src/features/ci/githubDeployments';
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

describe('anyDeploymentActive', () => {
  const deployment = (state: CiDeployment['state']): CiDeployment => ({ id: 1, environment: 'staging', state, sha: 'abc', created: '2026-10-10T10:00:00Z', url: 'https://github.com/a/b' });

  it('is true while a deployment is in progress, and only then', () => {
    expect(anyDeploymentActive([deployment('success'), deployment('in_progress')])).toBe(true);
    expect(anyDeploymentActive([deployment('success'), deployment('failure'), deployment('inactive')])).toBe(false);
    expect(anyDeploymentActive([])).toBe(false);
  });
});
