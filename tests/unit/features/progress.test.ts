import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeProgress, resolveBase } from '../../../src/features/workstreams/progress';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
const headOf = (dir: string, ref: string) => git(dir, 'rev-parse', ref).trim();

describe('resolveBase', () => {
  it('prefers a valid configured base, then origin/HEAD, then main/master', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await resolveBase(repo, 'nope')).toBe('main');
    expect(await resolveBase(repo, 'HEAD')).toBe('HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveBase(repo, '')).toBe('origin/main');
  });

  it('takes local main over origin/main when it has commits origin lacks (not pushed yet), not when it is behind', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const commit = (name: string) => {
      writeFile(repo, `${name}.txt`, name);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', name);
    };
    // Ahead: work on main that isn't pushed.
    commit('local');
    expect(await resolveBase(repo, '')).toBe('main');
    // Diverged: origin moved on too; main still has work origin lacks.
    const local = headOf(repo, 'HEAD');
    git(repo, 'checkout', '-q', '--detach', 'origin/main');
    commit('remote');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    expect(await resolveBase(repo, '')).toBe('main');
    // Behind: origin has everything main has, and more.
    git(repo, 'reset', '-q', '--hard', 'origin/main');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    expect(headOf(repo, 'HEAD')).not.toBe(local);
    expect(await resolveBase(repo, '')).toBe('origin/main');
    // A configured base still wins.
    expect(await resolveBase(repo, 'HEAD')).toBe('HEAD');
  });

  it('returns undefined when nothing fits', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    git(repo, 'branch', '-m', 'main', 'trunk');
    expect(await resolveBase(repo, '')).toBeUndefined();
  });
});

describe('computeProgress', () => {
  it('reports ahead/behind, line stats against the merge-base and the last subject', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const wt = path.join(repo, '.worktrees', 'feat');
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    writeFile(wt, 'a.txt', 'one\ntwo\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'add a');
    writeFile(wt, 'b.txt', 'three\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'add b');
    writeFile(wt, 'README.md', 'changed\n');
    writeFile(repo, 'main.txt', 'm\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moves');

    expect(await computeProgress(wt, 'main', headOf(repo, 'main'))).toEqual({ base: 'main', baseHead: headOf(repo, 'main'), ahead: 2, behind: 1, added: 4, deleted: 1, lastSubject: 'add b' });
  });

  it('returns zeros for a repo without commits and for a missing base', async () => {
    const empty = makeTempDir();
    cleanup.push(empty);
    git(empty, 'init', '-q');
    expect(await computeProgress(empty, 'main', undefined)).toEqual({ base: 'main', baseHead: undefined, ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: undefined });
    const repo = initRepo();
    cleanup.push(repo);
    expect(await computeProgress(repo, undefined, undefined)).toEqual({ base: undefined, baseHead: undefined, ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: 'initial' });
  });
});
