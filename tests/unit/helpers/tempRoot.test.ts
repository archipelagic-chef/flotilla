import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../../helpers/gitRepo';
import { sweepDeadRuns } from '../../helpers/tempRoot';

describe('the test run temp folder', () => {
  it('is the temp folder the tests see, so its teardown removes what they leave', () => {
    expect(path.basename(path.dirname(os.tmpdir()))).toBe('flotilla-tests');
    expect(path.basename(os.tmpdir())).toMatch(/^run-\d+-/);
    const dir = makeTempDir();
    expect(path.dirname(dir)).toBe(fs.realpathSync.native(os.tmpdir()));
    removeDir(dir);
  });

  it('sweeps the folders of runs that no longer run, and keeps the others', () => {
    const runs = makeTempDir('runs-');
    for (const name of ['run-111-a', 'run-222-b', 'other']) fs.mkdirSync(path.join(runs, name, 'repo'), { recursive: true });
    sweepDeadRuns(runs, (pid) => pid === 222);
    expect(fs.readdirSync(runs).sort()).toEqual(['other', 'run-222-b']);
    removeDir(runs);
  });
});
