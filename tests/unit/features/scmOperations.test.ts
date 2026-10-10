import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStatusV2 } from '../../../src/core/git/porcelain';
import { commit, discard, listRemotes, publish, pull, push, stage, stageAll, sync, unstage, unstageAll } from '../../../src/features/scm/operations';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function repo(): string {
  const dir = initRepo();
  cleanup.push(dir);
  return dir;
}

function status(dir: string) {
  return parseStatusV2(git(dir, 'status', '--porcelain=v2', '--branch', '-z'));
}

/** A repo with a bare `origin` that has `main` pushed. */
function withRemote(): { dir: string; bare: string } {
  const dir = repo();
  const bare = makeTempDir('flotilla-bare-');
  cleanup.push(bare);
  git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, bare };
}

describe('staging', () => {
  it('stages and unstages individual paths, including literal special characters and deletions', async () => {
    const dir = repo();
    writeFile(dir, 'a*.txt', 'star\n');
    writeFile(dir, 'ab.txt', 'other\n');
    fs.rmSync(path.join(dir, 'README.md'));

    await stage(dir, ['a*.txt', 'README.md']);
    let s = status(dir);
    expect(s.staged).toEqual([
      { path: 'README.md', kind: 'deleted' },
      { path: 'a*.txt', kind: 'added' },
    ]);
    expect(s.unstaged).toEqual([{ path: 'ab.txt', kind: 'untracked' }]);

    await unstage(dir, ['README.md']);
    s = status(dir);
    expect(s.staged).toEqual([{ path: 'a*.txt', kind: 'added' }]);
    expect(s.unstaged).toContainEqual({ path: 'README.md', kind: 'deleted' });
  });

  it('stages and unstages everything', async () => {
    const dir = repo();
    writeFile(dir, 'README.md', 'changed\n');
    writeFile(dir, 'new.txt', 'x\n');
    await stageAll(dir);
    expect(status(dir).unstaged).toEqual([]);
    expect(status(dir).staged).toHaveLength(2);
    await unstageAll(dir);
    expect(status(dir).staged).toEqual([]);
  });

  it('unstages in a repository without commits', async () => {
    const dir = makeTempDir();
    cleanup.push(dir);
    git(dir, 'init', '-q');
    writeFile(dir, 'a.txt', 'a\n');
    writeFile(dir, 'b.txt', 'b\n');
    await stageAll(dir);
    await unstage(dir, ['a.txt']);
    expect(status(dir).staged).toEqual([{ path: 'b.txt', kind: 'added' }]);
    await unstageAll(dir);
    expect(status(dir).staged).toEqual([]);
  });
});

describe('discard', () => {
  it('restores tracked files to their staged version and deletes untracked files', async () => {
    const dir = repo();
    writeFile(dir, 'README.md', 'staged\n');
    git(dir, 'add', 'README.md');
    writeFile(dir, 'README.md', 'working\n');
    writeFile(dir, 'junk/file.txt', 'x\n');
    await discard(dir, status(dir).unstaged);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('staged\n');
    expect(fs.existsSync(path.join(dir, 'junk'))).toBe(false);
    expect(status(dir).unstaged).toEqual([]);
  });

  it('refuses conflicted files', async () => {
    const dir = repo();
    await expect(discard(dir, [{ path: 'x', kind: 'conflicted' }])).rejects.toThrow(/merge conflicts/);
  });
});

describe('commit', () => {
  it('commits staged changes with a multi-line message', async () => {
    const dir = repo();
    writeFile(dir, 'a.txt', 'a\n');
    await stage(dir, ['a.txt']);
    await commit(dir, 'Add a\n\nBody line');
    expect(git(dir, 'log', '-1', '--format=%B')).toBe('Add a\n\nBody line');
    expect(status(dir).staged).toEqual([]);
  });

  it('fails when nothing is staged', async () => {
    const dir = repo();
    await expect(commit(dir, 'empty')).rejects.toThrow();
  });
});

describe('remotes', () => {
  it('lists remotes', async () => {
    const { dir } = withRemote();
    expect(await listRemotes(dir)).toEqual(['origin']);
    expect(await listRemotes(repo())).toEqual([]);
  });

  it('publishes a branch and sets its upstream, then pushes new commits', async () => {
    const { dir, bare } = withRemote();
    git(dir, 'switch', '-q', '-c', 'feature/x');
    await publish(dir, 'feature/x', 'origin');
    expect(status(dir).branch.upstream).toBe('origin/feature/x');

    writeFile(dir, 'a.txt', 'a\n');
    await stageAll(dir);
    await commit(dir, 'a');
    expect(status(dir).branch.ahead).toBe(1);
    await push(dir);
    expect(status(dir).branch.ahead).toBe(0);
    expect(git(bare, 'log', '-1', '--format=%s', 'feature/x')).toBe('a');
  });

  it('pulls and syncs with the upstream', async () => {
    const { dir, bare } = withRemote();
    const other = makeTempDir('flotilla-clone-');
    cleanup.push(other);
    git(other, 'clone', '-q', bare, '.');
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.com');
    writeFile(other, 'theirs.txt', 'x\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q');

    git(dir, 'fetch', '-q');
    expect(status(dir).branch.behind).toBe(1);
    await pull(dir);
    expect(fs.existsSync(path.join(dir, 'theirs.txt'))).toBe(true);

    writeFile(dir, 'mine.txt', 'y\n');
    await stageAll(dir);
    await commit(dir, 'mine');
    await sync(dir);
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('mine');
  });
});

describe('commit --amend', () => {
  it('amends with a new message, or keeps the old one when the message is empty', async () => {
    const { initRepo: init, git: g, writeFile: w } = await import('../../helpers/gitRepo');
    const { commit: c } = await import('../../../src/features/scm/operations');
    const repo = init();
    w(repo, 'a.txt', 'a\n');
    g(repo, 'add', '.');
    await c(repo, 'first');
    w(repo, 'b.txt', 'b\n');
    g(repo, 'add', '.');
    await c(repo, '', { amend: true });
    expect(g(repo, 'log', '-1', '--format=%s')).toBe('first');
    expect(g(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'b.txt']);
    await c(repo, 'renamed', { amend: true });
    expect(g(repo, 'log', '-1', '--format=%s')).toBe('renamed');
    expect(g(repo, 'rev-list', '--count', 'HEAD')).toBe('2');
  });
});
