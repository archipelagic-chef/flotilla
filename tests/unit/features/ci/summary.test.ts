import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ciState,
  ciSummary,
  failedWorkflows,
  scopeState,
  scopeSummary,
} from '../../../../src/features/ci/summary';
import type {
  CiRunView,
  CiView,
} from '../../../../src/webview/protocol';

const run = (workflow: string, status: CiRunView['status'], id = 1): CiRunView => ({
  id,
  workflow,
  number: id,
  title: 'A commit',
  event: 'push',
  status,
  url: 'https://github.com/acme/app/actions/runs/1',
  sha: 'abc',
  attempt: 1,
  created: '2026-10-11T10:00:00Z',
  current: false,
});

const runs = (...rs: CiRunView[]): CiView => ({ kind: 'runs', repo: 'acme/app', branch: 'feat', runs: rs, deployments: [] });

describe('ciState and failedWorkflows', () => {
  it("takes the worst of each workflow's latest run, and names the workflows whose latest run failed", () => {
    // Runs are newest first: the latest CI failed, the older one passed; Deploy's latest passed.
    const view = runs(run('CI', 'failure', 4), run('CI', 'success', 2), run('Deploy', 'success', 1));
    expect(ciState(view)).toBe('failure');
    expect(failedWorkflows(view)).toEqual(['CI']);
  });

  it('has no state for a view without runs', () => {
    expect(ciState({ kind: 'signIn' })).toBeUndefined();
    expect(failedWorkflows({ kind: 'unpublished' })).toEqual([]);
  });
});

describe('ciSummary', () => {
  it('says the state and the failed workflows, or why there are no runs', () => {
    expect(ciSummary(runs(run('CI', 'failure'), run('Lint', 'success')))).toBe('CI failed: CI');
    expect(ciSummary(runs(run('CI', 'running')))).toBe('CI running');
    expect(ciSummary(runs(run('CI', 'success')))).toBe('CI passed');
    expect(ciSummary(runs())).toBe('No runs for this branch yet.');
    expect(ciSummary({ kind: 'signIn' })).toBe('Sign in to GitHub to see its CI.');
    expect(ciSummary({ kind: 'unpublished' })).toBe('Publish this branch to run its CI.');
    expect(ciSummary({ kind: 'unsupported' })).toBe('CI/CD supports GitHub Actions only for now.');
    expect(ciSummary({ kind: 'error', error: '403 Forbidden' })).toBe('403 Forbidden');
    expect(ciSummary(undefined)).toBe('');
  });
});

describe('scopeState and scopeSummary: one worktree, or the worst of all (the All tab)', () => {
  const passed = runs(run('CI', 'success'));
  const failed = runs(run('CI', 'failure'));
  it('takes the worst state, and names the failures only when the worst is a failure', () => {
    expect(scopeState([passed, undefined, { kind: 'signIn' }])).toBe('success');
    expect(scopeState([passed, failed])).toBe('failure');
    expect(scopeState([runs(run('CI', 'running')), passed])).toBe('running');
    expect(scopeState([undefined])).toBeUndefined();
    expect(scopeSummary([passed, failed])).toBe('CI failed: CI');
    expect(scopeSummary([runs(run('CI', 'running')), failed])).toBe('CI failed: CI');
    expect(scopeSummary([runs(run('CI', 'running'))])).toBe('CI running');
    expect(scopeSummary([undefined])).toBe('');
  });
});
