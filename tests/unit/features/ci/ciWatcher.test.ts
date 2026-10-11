import { describe, expect, it } from 'vitest';
import { ACTIVE_CHECK_MS, CHECK_MS, CiWatcher, ciView, notifies, type CiRuns, type CiTarget } from '../../../../src/features/ci/ciWatcher';
import { ciStatus, finished, splitUpstream, type CiRun } from '../../../../src/features/ci/githubActions';
import { ciSummary, scopeState } from '../../../../src/features/ci/summary';

const run = (over: Partial<CiRun> & Pick<CiRun, 'id' | 'workflow' | 'status'>): CiRun => ({
  number: 1,
  title: 'A commit',
  event: 'push',
  url: `https://github.com/acme/app/actions/runs/${over.id}`,
  sha: 'abcdef1234567',
  attempt: 1,
  created: '2026-10-11T10:00:00Z',
  updated: '2026-10-11T10:00:00Z',
  ...over,
});

const target = (key: string, revision = 'h1'): CiTarget => ({ key, revision, github: { owner: 'acme', repo: 'app', branch: `feat/${key}` } });

/** A client that answers with the runs it's given, and counts the reads. */
function clientWith(runs: { current: CiRun[] }) {
  let reads = 0;
  const client: CiRuns = {
    async runs() {
      reads++;
      return runs.current;
    },
  };
  return { client, reads: () => reads };
}

describe('ciStatus', () => {
  it('maps GitHub status and conclusion to one state', () => {
    expect(ciStatus('queued', null)).toBe('queued');
    expect(ciStatus('in_progress', null)).toBe('running');
    expect(ciStatus('completed', 'success')).toBe('success');
    expect(ciStatus('completed', 'failure')).toBe('failure');
    expect(ciStatus('completed', 'timed_out')).toBe('failure');
    expect(ciStatus('completed', 'cancelled')).toBe('cancelled');
    expect(ciStatus('completed', 'skipped')).toBe('skipped');
  });
});

describe('splitUpstream', () => {
  it('splits by the longest remote that fits, so a remote with a slash in its name works', () => {
    expect(splitUpstream('origin/feat/x', ['origin', 'origin/feat'])).toEqual({ remote: 'origin/feat', branch: 'x' });
    expect(splitUpstream('origin/feat/x', ['origin/feat', 'origin'])).toEqual({ remote: 'origin/feat', branch: 'x' });
    expect(splitUpstream('origin/feat/x', ['origin'])).toEqual({ remote: 'origin', branch: 'feat/x' });
    expect(splitUpstream('local/x', ['origin'])).toBeUndefined();
  });
});

describe('finished', () => {
  it('lists the runs that were running and are done now, not the ones already done when first read', () => {
    const before = [run({ id: 1, workflow: 'CI', status: 'running' }), run({ id: 2, workflow: 'CI', status: 'success' })];
    const now = [run({ id: 1, workflow: 'CI', status: 'failure' }), run({ id: 2, workflow: 'CI', status: 'success' })];
    expect(finished(before, now).map((r) => r.id)).toEqual([1]);
    expect(finished([], now)).toEqual([]);
  });
});

describe('ciView and the scope', () => {
  it('takes the state from the latest run of each workflow, and names the workflows that failed', () => {
    const runs = [
      run({ id: 3, workflow: 'Deploy', status: 'success' }),
      run({ id: 4, workflow: 'CI', status: 'failure' }),
      run({ id: 2, workflow: 'CI', status: 'success' }),
      run({ id: 1, workflow: 'Lint', status: 'success' }),
    ];
    const view = ciView(runs, 'https://example.test/runs');
    expect(view.state).toBe('failure');
    expect(view.failed).toEqual(['CI']);
    expect(view.url).toBe('https://example.test/runs');
  });

  it('shows the worst of the worktrees on the All tab, and only a failure names workflows', () => {
    const passed = { state: 'success' as const, failed: [] };
    const failed = { state: 'failure' as const, failed: ['CI'] };
    expect(scopeState([passed, undefined])).toBe('success');
    expect(scopeState([passed, failed])).toBe('failure');
    expect(scopeState([{ state: 'running', failed: [] }, passed])).toBe('running');
    expect(scopeState([undefined])).toBeUndefined();
    expect(ciSummary(failed)).toBe('CI failed: CI');
    expect(ciSummary({ failed: [], note: 'Publish this branch to run its CI.' })).toBe('Publish this branch to run its CI.');
    expect(ciSummary(undefined)).toBe('');
  });
});

describe('notifies', () => {
  it('tells about failures by default, every finished run with all, and nothing when off', () => {
    const ok = run({ id: 1, workflow: 'CI', status: 'success' });
    const bad = run({ id: 2, workflow: 'CI', status: 'failure' });
    expect([notifies(ok, 'failures'), notifies(bad, 'failures')]).toEqual([false, true]);
    expect([notifies(ok, 'all'), notifies(bad, 'all')]).toEqual([true, true]);
    expect([notifies(ok, 'off'), notifies(bad, 'off')]).toEqual([false, false]);
  });
});

describe('CiWatcher', () => {
  it('reads a branch once and then after its interval, a minute or 10 s while a run is going', async () => {
    let now = 0;
    const runs = { current: [run({ id: 1, workflow: 'CI', status: 'success' })] };
    const { client, reads } = clientWith(runs);
    const watcher = new CiWatcher({ clientFor: async () => client, now: () => now });
    await watcher.poll([target('a')]);
    expect(reads()).toBe(1);
    now += CHECK_MS - 1;
    await watcher.poll([target('a')]);
    expect(reads()).toBe(1);
    now += 1;
    await watcher.poll([target('a')]);
    expect(reads()).toBe(2);

    // Once a run is going, the branch is read every 10 s.
    runs.current = [run({ id: 2, workflow: 'CI', status: 'running' })];
    now += CHECK_MS;
    await watcher.poll([target('a')]);
    expect(reads()).toBe(3);
    now += ACTIVE_CHECK_MS - 1;
    await watcher.poll([target('a')]);
    expect(reads()).toBe(3);
    now += 1;
    await watcher.poll([target('a')]);
    expect(reads()).toBe(4);
  });

  it('reads at once when the branch moved, and reports only runs that finished after being seen running', async () => {
    let now = 0;
    const runs = { current: [run({ id: 1, workflow: 'CI', status: 'success' })] };
    const { client } = clientWith(runs);
    const watcher = new CiWatcher({ clientFor: async () => client, now: () => now });
    // Start-up: a run that is already done is not news.
    expect(await watcher.poll([target('a', 'h1')])).toEqual([]);

    runs.current = [run({ id: 2, workflow: 'CI', status: 'running' })];
    expect(await watcher.poll([target('a', 'h2')])).toEqual([]);
    now += ACTIVE_CHECK_MS;

    runs.current = [run({ id: 2, workflow: 'CI', status: 'failure' })];
    now += ACTIVE_CHECK_MS;
    const finishedNow = await watcher.poll([target('a', 'h2')]);
    expect(finishedNow.map((f) => [f.key, f.run.id, f.run.status])).toEqual([['a', 2, 'failure']]);
    expect(watcher.views().a.state).toBe('failure');
    expect(watcher.views().a.failed).toEqual(['CI']);
  });

  it('gives a note, not runs, for a branch that is not published or not on GitHub, and asks for a sign-in when there is none', async () => {
    const watcher = new CiWatcher({ clientFor: async () => undefined, now: () => 0 });
    await watcher.poll([{ key: 'a', revision: 'h', note: 'Publish this branch to run its CI.' }]);
    expect(watcher.views().a).toEqual({ failed: [], note: 'Publish this branch to run its CI.' });

    await watcher.poll([target('b')]);
    expect(watcher.views().b).toMatchObject({ note: 'Sign in to GitHub to see its CI.' });
    expect(watcher.views().b.state).toBeUndefined();
  });

  it('keeps the last runs and says why when the API fails, and forgets worktrees that are gone', async () => {
    let now = 0;
    let fail = false;
    const runs = { current: [run({ id: 1, workflow: 'CI', status: 'success' })] };
    const client: CiRuns = {
      async runs() {
        if (fail) throw new Error('403 Forbidden');
        return runs.current;
      },
    };
    const watcher = new CiWatcher({ clientFor: async () => client, now: () => now });
    await watcher.poll([target('a'), target('b')]);
    fail = true;
    now += CHECK_MS;
    await watcher.poll([target('a')]);
    expect(watcher.views().a).toMatchObject({ state: 'success', note: '403 Forbidden' });
    expect(watcher.views().b).toBeUndefined();
  });
});
