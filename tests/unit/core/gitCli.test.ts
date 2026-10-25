import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  getGitVersion,
  GitError,
  MIN_GIT_VERSION,
  parseGitVersion,
  runGit,
  versionAtLeast,
} from '../../../src/core/git/gitCli';
import { initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('git version helpers', () => {
  it('parses version strings from different platforms', () => {
    expect(parseGitVersion('git version 2.31.1.windows.1\n')).toEqual([2, 31, 1]);
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39, 5]);
    expect(parseGitVersion('git version 2.17')).toEqual([2, 17, 0]);
    expect(parseGitVersion('nonsense')).toBeUndefined();
  });

  it('compares versions', () => {
    expect(versionAtLeast([2, 17, 0], MIN_GIT_VERSION)).toBe(true);
    expect(versionAtLeast([2, 16, 9], MIN_GIT_VERSION)).toBe(false);
    expect(versionAtLeast([3, 0, 0], MIN_GIT_VERSION)).toBe(true);
    expect(versionAtLeast([2, 48, 1], [2, 48, 0])).toBe(true);
  });

  it('reads the installed git version', async () => {
    const v = await getGitVersion(makeTempDir());
    expect(v).toBeDefined();
    expect(versionAtLeast(v!, MIN_GIT_VERSION)).toBe(true);
  });
});

describe('runGit', () => {
  it('returns stdout', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect((await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).trim()).toBe('main');
  });

  it('throws GitError with exit code and stderr on failure', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const error = await runGit(['rev-parse', '--verify', 'does-not-exist'], { cwd: repo }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBe(128);
    expect(error.stderr).toMatch(/fatal/);
  });

  it('throws GitError with null exit code when the cwd is missing', async () => {
    const error = await runGit(['status'], { cwd: path.join(makeTempDir(), 'missing') }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.exitCode).toBeNull();
  });
});
