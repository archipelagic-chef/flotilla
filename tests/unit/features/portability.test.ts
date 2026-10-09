import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isPortable,
  LOCK_REASON,
  makePortable,
  readGitFile,
  relativeGitdir,
  resolveGitdir,
  retargetBackPointer,
  unlock,
} from '../../../src/features/worktrees/portability';
import { git, initRepo, makeTempDir, removeDir, simulateOtherEnvironment, symlinkedRepo } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

async function addWorktree(repo: string, name: string): Promise<{ dir: string; admin: string }> {
  const dir = path.join(repo, '.worktrees', name);
  git(repo, 'worktree', 'add', '-b', name, dir);
  const value = await readGitFile(dir);
  return { dir, admin: resolveGitdir(dir, value!) };
}

describe('relativeGitdir', () => {
  it('computes a forward-slash relative path', () => {
    const root = makeTempDir();
    cleanup.push(root);
    expect(relativeGitdir(path.join(root, '.worktrees', 'a'), path.join(root, '.git', 'worktrees', 'a'))).toBe('../../.git/worktrees/a');
  });
});

describe('makePortable', () => {
  it('rewrites the .git file to a relative path and locks the worktree', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const { dir, admin } = await addWorktree(repo, 'feat');
    expect(await isPortable(dir, admin)).toBe(false);
    expect(await makePortable(dir, admin)).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe('gitdir: ../../.git/worktrees/feat\n');
    expect(fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim()).toBe(LOCK_REASON);
    expect(await isPortable(dir, admin)).toBe(true);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
  });

  it('keeps an existing lock and its reason', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const { dir, admin } = await addWorktree(repo, 'feat');
    git(repo, 'worktree', 'lock', '--reason', 'mine', dir);
    await makePortable(dir, admin);
    expect(fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim()).toBe('mine');
  });

  it.skipIf(process.platform === 'win32')('computes the relative path from real paths when the worktree is reached through a symlink', async () => {
    const { repo, linkedRepo, dirs } = symlinkedRepo();
    cleanup.push(...dirs);
    const { admin } = await addWorktree(repo, 'feat');
    const linkedDir = path.join(linkedRepo, '.worktrees', 'feat');
    expect(await makePortable(linkedDir, admin)).toBe(true);
    expect(fs.readFileSync(path.join(linkedDir, '.git'), 'utf8')).toBe('gitdir: ../../.git/worktrees/feat\n');
    expect(git(linkedDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
  });

  it('restores the .git file and returns false when git does not accept the rewritten path', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const { dir, admin } = await addWorktree(repo, 'feat');
    const notAGitDir = path.join(repo, '.git', 'worktrees', 'not-a-git-dir');
    fs.mkdirSync(notAGitDir);
    const original = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    expect(await makePortable(dir, notAGitDir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(notAGitDir, 'locked'))).toBe(false);
    expect(fs.existsSync(path.join(admin, 'locked'))).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
  });

  it('refuses to touch a .git directory', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await makePortable(repo, path.join(repo, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'HEAD'))).toBe(true);
  });
});

describe('second environment (repo seen at a different absolute path)', () => {
  it('portable worktrees keep working, plain ones break, prune keeps locked entries', async () => {
    const repo = initRepo();
    const portable = await addWorktree(repo, 'feat');
    await makePortable(portable.dir, portable.admin);
    await addWorktree(repo, 'plain');
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);

    expect(git(path.join(other, '.worktrees', 'feat'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
    expect(() => git(path.join(other, '.worktrees', 'plain'), 'status')).toThrow();

    git(other, 'worktree', 'prune');
    expect(fs.existsSync(path.join(other, '.git', 'worktrees', 'feat'))).toBe(true);
  });

  it('retargeting the back-pointer lets git worktree remove work there', async () => {
    const repo = initRepo();
    const { dir, admin } = await addWorktree(repo, 'feat');
    await makePortable(dir, admin);
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`);
    const movedDir = path.join(other, '.worktrees', 'feat');
    const movedAdmin = path.join(other, '.git', 'worktrees', 'feat');

    expect(await retargetBackPointer(movedDir, movedAdmin)).toBe(true);
    expect(await retargetBackPointer(movedDir, movedAdmin)).toBe(false);
    await unlock(movedAdmin);
    git(other, 'worktree', 'remove', movedDir);
    expect(fs.existsSync(movedDir)).toBe(false);
    expect(fs.existsSync(movedAdmin)).toBe(false);
  });
});
