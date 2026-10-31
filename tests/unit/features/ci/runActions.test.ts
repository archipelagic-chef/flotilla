import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  explainRunError,
  runActions,
} from '../../../../src/features/ci/runActions';

describe('runActions', () => {
  it('offers re-run for a finished run, and re-run failed jobs when one failed', () => {
    expect(runActions({ active: false, failed: false })).toEqual(['rerun']);
    expect(runActions({ active: false, failed: true })).toEqual(['rerun', 'rerunFailed']);
  });

  it('offers only cancel for a queued or running run', () => {
    expect(runActions({ active: true, failed: false })).toEqual(['cancel']);
    expect(runActions({ active: true, failed: true })).toEqual(['cancel']);
  });
});

describe('explainRunError', () => {
  it('tells the user to sign in again when the token is refused', () => {
    expect(explainRunError('cancel', 401, '', 'acme/app')).toMatch(/Sign in to GitHub again/);
  });

  it('reads "too old" from the words, not from a fragment of another word', () => {
    expect(explainRunError('rerun', 403, 'Forbidden: this run is older than 30 days', 'acme/app')).toMatch(/too old/);
    expect(explainRunError('rerun', 403, 'the logs folder is not accessible', 'acme/app')).toMatch(/write access/);
  });

  it('says a failed-jobs re-run has nothing to re-run', () => {
    expect(explainRunError('rerunFailed', 422, '', 'acme/app')).toMatch(/no job in this run failed/);
  });
});
