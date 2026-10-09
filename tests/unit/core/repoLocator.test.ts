import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateRepo } from '../../../src/core/repoLocator';
import { expectSamePath, git, initRepo, makeTempDir, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('locateRepo', () => {
  it('locates the main worktree from its root and from a subfolder', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    fs.mkdirSync(path.join(repo, 'src'));
    for (const folder of [repo, path.join(repo, 'src')]) {
      const loc = await locateRepo(folder);
      expectSamePath(loc?.mainRoot, repo);
      expectSamePath(loc?.commonDir, path.join(repo, '.git'));
      expectSamePath(loc?.worktreeRoot, repo);
      expectSamePath(loc?.gitDir, path.join(repo, '.git'));
    }
  });

  it('locates the main repo from a linked worktree', async () => {
    const repo = initRepo();
    const wt = path.join(makeTempDir(), 'wt');
    cleanup.push(repo, path.dirname(wt));
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    const loc = await locateRepo(wt);
    expectSamePath(loc?.mainRoot, repo);
    expectSamePath(loc?.worktreeRoot, wt);
    expectSamePath(loc?.gitDir, path.join(repo, '.git', 'worktrees', 'wt'));
  });

  it('returns undefined outside a repository', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    expect(await locateRepo(dir)).toBeUndefined();
  });
});
