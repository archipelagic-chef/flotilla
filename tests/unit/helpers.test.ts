import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, initRepo, removeDir, simulateOtherEnvironment } from '../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('test helpers', () => {
  it('creates a repo on main with one commit', () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('simulates a second environment by moving the repo', () => {
    const repo = initRepo();
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);
    expect(fs.existsSync(repo)).toBe(false);
    expect(git(other, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
