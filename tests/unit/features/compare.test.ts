import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKING } from '../../../src/core/diff/refs';
import { compareWithBase } from '../../../src/features/diffs/compare';
import { git, initRepo, makeStatDirty, removeDir, restatInPast, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function fixture(): { repo: string; wt: string } {
  const repo = initRepo();
  cleanup.push(repo);
  writeFile(repo, 'docs.md', 'line\n'.repeat(20));
  writeFile(repo, 'shared.txt', 'shared\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'docs');
  const wt = path.join(repo, '.worktrees', 'feat');
  git(repo, 'worktree', 'add', '-b', 'feat', wt);
  writeFile(wt, 'README.md', 'changed\n');
  writeFile(wt, 'new.txt', 'new\n');
  git(wt, 'mv', 'docs.md', 'guide.md');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'feature work');
  writeFile(repo, 'main-only.txt', 'm\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main moves');
  writeFile(wt, 'shared.txt', 'edited, not committed\n');
  return { repo, wt };
}

const sortByPath = <T extends { path: string }>(list: T[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

describe('compareWithBase', () => {
  it('mergeBase mode shows only the branch changes', async () => {
    const { wt } = fixture();
    const result = await compareWithBase(wt, 'main', 'mergeBase');
    expect(result.rightRef).toBe('HEAD');
    expect(result.leftRef).toMatch(/^[0-9a-f]{40}$/);
    expect(sortByPath(result.files)).toEqual([
      { path: 'README.md', kind: 'modified' },
      { path: 'guide.md', origPath: 'docs.md', kind: 'renamed' },
      { path: 'new.txt', kind: 'added' },
    ]);
  });

  it('twoDot mode also shows what changed on the base', async () => {
    const { wt } = fixture();
    const result = await compareWithBase(wt, 'main', 'twoDot');
    expect(result.leftRef).toBe('main');
    expect(result.files).toContainEqual({ path: 'main-only.txt', kind: 'deleted' });
  });

  it('uncommitted mode compares the merge-base with the working tree', async () => {
    const { wt } = fixture();
    const result = await compareWithBase(wt, 'main', 'uncommitted');
    expect(result.rightRef).toBe(WORKING);
    expect(result.files).toContainEqual({ path: 'shared.txt', kind: 'modified' });
    expect(result.files).toContainEqual({ path: 'new.txt', kind: 'added' });
  });

  it('uncommitted mode does not modify the worktree index', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const tracked = ['one.txt', 'two.txt', 'three.txt'];
    makeStatDirty(repo, tracked);
    const wt = path.join(repo, '.worktrees', 'feat');
    git(repo, 'worktree', 'add', '-b', 'feat', wt);
    writeFile(wt, 'README.md', 'edited, not committed\n');
    restatInPast(wt, tracked);
    const indexPath = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'index'));
    const before = fs.statSync(indexPath).mtimeMs;
    const content = fs.readFileSync(indexPath);
    const result = await compareWithBase(wt, 'main', 'uncommitted');
    await compareWithBase(wt, 'main', 'uncommitted');
    expect(result.files).toEqual([{ path: 'README.md', kind: 'modified' }]);
    expect(fs.statSync(indexPath).mtimeMs).toBe(before);
    expect(fs.readFileSync(indexPath).equals(content)).toBe(true);
  });
});
