import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import * as fs from 'node:fs';
import {
  getGitVersion,
  versionAtLeast,
} from '../../../src/core/git/gitCli';
import {
  indexConflicts,
  mergeConflicts,
  mergeTreeConflicts,
} from '../../../src/core/git/mergeCheck';
import {
  git,
  initRepo,
  writeFile,
} from '../../helpers/gitRepo';

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** main and a feature branch from it, each with its own commit on top. */
function fixture(main: Record<string, string | null>, feature: Record<string, string | null>): string {
  const root = initRepo();
  repos.push(root);
  writeFile(root, 'a.txt', 'one\ntwo\nthree\n');
  writeFile(root, 'b.txt', 'b\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'branch', 'feature');
  const commit = (files: Record<string, string | null>, message: string) => {
    for (const [f, content] of Object.entries(files)) {
      if (content === null) git(root, 'rm', '-q', f);
      else {
        writeFile(root, f, content);
        git(root, 'add', f);
      }
    }
    git(root, 'commit', '-q', '-m', message);
  };
  commit(main, 'main');
  git(root, 'checkout', '-q', 'feature');
  commit(feature, 'feature');
  git(root, 'checkout', '-q', 'main');
  return root;
}

const modern = await getGitVersion(process.cwd()).then((v) => !!v && versionAtLeast(v, [2, 38, 0]));
const ways = [
  ['merge-file in a throwaway index', indexConflicts],
  ...(modern ? [['merge-tree --write-tree', mergeTreeConflicts] as const] : []),
  ['the way this git has', mergeConflicts],
] as const;

describe.each(ways)('mergeConflicts with %s', (_name, check) => {
  it('finds none when the branches change different lines or files', async () => {
    const root = fixture({ 'a.txt': 'ONE\ntwo\nthree\n' }, { 'a.txt': 'one\ntwo\nTHREE\n', 'c.txt': 'new\n' });
    expect(await check(root, 'feature', 'main')).toEqual([]);
  });

  it('names the files both change in the same place', async () => {
    const root = fixture({ 'a.txt': 'one\nTWO\nthree\n', 'b.txt': 'main\n' }, { 'a.txt': 'one\n2\nthree\n', 'b.txt': 'feature\n' });
    expect((await check(root, 'feature', 'main')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('counts a file changed on one side and deleted on the other', async () => {
    const root = fixture({ 'b.txt': null }, { 'b.txt': 'changed\n' });
    expect(await check(root, 'feature', 'main')).toEqual(['b.txt']);
  });

  it('counts a file both add with different contents', async () => {
    const root = fixture({ 'n.txt': 'main\n' }, { 'n.txt': 'feature\n' });
    expect(await check(root, 'feature', 'main')).toEqual(['n.txt']);
  });

  it('leaves the worktree and index as they were', async () => {
    const root = fixture({ 'a.txt': 'x\n' }, { 'a.txt': 'y\n' });
    await check(root, 'feature', 'main');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
