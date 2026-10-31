import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { commitFileDiff } from '../../../src/features/diffs/commitFileDiff';
import {
  commitsTouching,
  startCommit,
} from '../../../src/features/history/log';
import {
  git,
  initRepo,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

/** A repo with three commits after the first: a.txt added, b.txt added, a.txt changed. Their hashes, oldest first. */
function threeCommits(): { dir: string; hashes: string[] } {
  const dir = initRepo();
  cleanup.push(dir);
  const commit = (file: string, text: string, message: string) => {
    writeFile(dir, file, text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, hashes: [commit('a.txt', 'one\ntwo\n', 'Add a'), commit('b.txt', 'b\n', 'Add b'), commit('a.txt', 'one\nTWO\n', 'Change a')] };
}

describe('startCommit', () => {
  const commits = [{ hash: 'c3' }, { hash: 'c2' }, { hash: 'c1' }];

  it('starts at the latest commit that changes the file', () => {
    expect(startCommit(commits, new Set(['c1', 'c2']))).toBe('c2');
  });

  it('starts at the latest commit when none changes it', () => {
    expect(startCommit(commits, new Set())).toBe('c3');
  });

  it('has none to start at without commits', () => {
    expect(startCommit([], new Set(['c1']))).toBeUndefined();
  });
});

describe('commitsTouching', () => {
  it('finds the commits, of those given, that change the file', async () => {
    const { dir, hashes } = threeCommits();
    expect(await commitsTouching(dir, hashes, ['a.txt'])).toEqual(new Set([hashes[0], hashes[2]]));
    expect(await commitsTouching(dir, hashes.slice(1, 2), ['a.txt'])).toEqual(new Set());
  });
});

describe('commitFileDiff', () => {
  it('reads the file as that commit changed it, all of the file', async () => {
    const { dir, hashes } = threeCommits();
    const { file, diff } = await commitFileDiff(dir, hashes[2], ['a.txt']);
    expect(file).toMatchObject({ path: 'a.txt', kind: 'modified', added: 1, deleted: 1 });
    expect('hunks' in diff && diff.hunks.flatMap((h) => h.lines.map((l) => `${l.kind[0]} ${l.text}`))).toEqual(['c one', 'd two', 'a TWO']);
  });

  it('reads a file the commit added', async () => {
    const { dir, hashes } = threeCommits();
    const { file, diff } = await commitFileDiff(dir, hashes[0], ['a.txt']);
    expect(file).toMatchObject({ kind: 'added', added: 2, deleted: 0 });
    expect('hunks' in diff && diff.hunks.flatMap((h) => h.lines.map((l) => l.kind))).toEqual(['added', 'added']);
  });

  it("says so when the commit doesn't change the file", async () => {
    const { dir, hashes } = threeCommits();
    expect(await commitFileDiff(dir, hashes[1], ['a.txt'])).toEqual({ diff: { note: "This commit doesn't change it." } });
  });

  it('finds a renamed file by its name before', async () => {
    const { dir } = threeCommits();
    git(dir, 'mv', 'b.txt', 'c.txt');
    git(dir, 'commit', '-q', '-m', 'Rename b');
    const { file } = await commitFileDiff(dir, git(dir, 'rev-parse', 'HEAD'), ['b.txt']);
    expect(file).toMatchObject({ path: 'c.txt', origPath: 'b.txt' });
  });
});
