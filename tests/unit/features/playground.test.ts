import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { git, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

// scripts/playground.mjs, run in a scratch directory: it creates .playground under the working directory.
const script = path.join(process.cwd(), 'scripts', 'playground.mjs');
const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function playground(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function scratch(): string {
  const dir = makeTempDir('flotilla-playground-');
  cleanup.push(dir);
  return dir;
}

/** The moved-aside playgrounds in `cwd`, oldest name first. */
function movedAside(cwd: string): string[] {
  return fs.readdirSync(cwd).filter((name) => /^\.playground\.old-/.test(name)).sort();
}

describe('scripts/playground.mjs', () => {
  it('creates a playground once and leaves an up-to-date one alone', () => {
    const cwd = scratch();
    expect(playground(cwd).stdout).toMatch(/Created playground/);
    expect(playground(cwd).stdout).toMatch(/already exists/);
    expect(git(path.join(cwd, '.playground'), 'config', 'flotilla.playgroundVersion')).toBe('1');
  });

  it('says an outdated playground is outdated, and leaves it as it is', () => {
    const cwd = scratch();
    playground(cwd);
    const playgroundDir = path.join(cwd, '.playground');
    writeFile(playgroundDir, 'mine.txt', 'keep me\n');
    git(playgroundDir, 'config', '--unset', 'flotilla.playgroundVersion');

    const result = playground(cwd);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/outdated/);
    expect(result.stdout).toMatch(/--reset/);
    expect(fs.readFileSync(path.join(playgroundDir, 'mine.txt'), 'utf8')).toBe('keep me\n');
    expect(movedAside(cwd)).toEqual([]);
  });

  it('moves the old playground aside with its worktrees, which still work there', () => {
    const cwd = scratch();
    playground(cwd);
    const playgroundDir = path.join(cwd, '.playground');
    writeFile(playgroundDir, '.gitignore', 'build.cache\n');
    git(playgroundDir, 'add', '.gitignore');
    git(playgroundDir, 'commit', '-q', '-m', 'ignore build output');
    const worktree = path.join(playgroundDir, '.worktrees', 'clean');
    git(playgroundDir, 'worktree', 'add', '-q', worktree, '-b', 'clean');
    writeFile(worktree, 'build.cache', 'ignored data\n');

    const result = playground(cwd, '--reset');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/worktree\(s\) moved with it and still work there/);
    const [old] = movedAside(cwd);
    expect(old).toBeDefined();
    const movedWorktree = path.join(cwd, old, '.worktrees', 'clean');
    expect(fs.readFileSync(path.join(movedWorktree, 'build.cache'), 'utf8')).toBe('ignored data\n');
    expect(git(path.join(cwd, old), 'worktree', 'list')).toMatch(/\.worktrees[\\/]clean .*\[clean\]/);
    expect(git(movedWorktree, 'branch', '--show-current')).toBe('clean');
    expect(git(playgroundDir, 'worktree', 'list')).not.toMatch(/\[clean\]/);
    expect(git(playgroundDir, 'config', 'flotilla.playgroundVersion')).toBe('1');
  });

  it('keeps a worktree’s uncommitted changes, staged ones included, when it moves aside', () => {
    const cwd = scratch();
    playground(cwd);
    const playgroundDir = path.join(cwd, '.playground');
    const worktree = path.join(playgroundDir, '.worktrees', 'dirty');
    git(playgroundDir, 'worktree', 'add', '-q', worktree, '-b', 'dirty');
    writeFile(worktree, 'staged.txt', 'staged\n');
    git(worktree, 'add', 'staged.txt');
    writeFile(worktree, 'untracked.txt', 'unsaved\n');

    const result = playground(cwd, '--reset');
    expect(result.status).toBe(0);
    const [old] = movedAside(cwd);
    const moved = path.join(cwd, old, '.worktrees', 'dirty');
    expect(git(moved, 'status', '--porcelain').split('\n').sort()).toEqual(['?? untracked.txt', 'A  staged.txt']);
  });

  it('moves a locked worktree aside too, still locked', () => {
    const cwd = scratch();
    playground(cwd);
    const playgroundDir = path.join(cwd, '.playground');
    const worktree = path.join(playgroundDir, '.worktrees', 'locked');
    git(playgroundDir, 'worktree', 'add', '-q', worktree, '-b', 'locked');
    git(playgroundDir, 'worktree', 'lock', worktree);

    const result = playground(cwd, '--reset');
    expect(result.status).toBe(0);
    const [old] = movedAside(cwd);
    expect(git(path.join(cwd, old), 'worktree', 'list')).toMatch(/\[locked\] locked$/m);
  });

  it('gives a second reset on the same day its own name', () => {
    const cwd = scratch();
    playground(cwd);
    playground(cwd, '--reset');
    playground(cwd, '--reset');
    const names = movedAside(cwd);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toEqual(names[1]);
  });

  it('creates a playground when there is none to reset', () => {
    const cwd = scratch();
    const result = playground(cwd, '--reset');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Created playground/);
    expect(movedAside(cwd)).toEqual([]);
  });
});
