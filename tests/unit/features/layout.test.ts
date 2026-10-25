import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  branchNameProblem,
  ensureExcluded,
  existingNames,
  sanitizeName,
  uniqueName,
  worktreesRoot,
} from '../../../src/features/worktrees/layout';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('sanitizeName', () => {
  it.each([
    ['feature/login', 'feature-login'],
    ['fix: thing?', 'fix-thing'],
    ['feat/ö-test', 'feat-ö-test'],
    ['..', 'worktree'],
    ['CON', 'CON-wt'],
    ['a\\b', 'a-b'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });
});

describe('uniqueName', () => {
  it('appends a numeric suffix, case-insensitively', () => {
    expect(uniqueName('a', new Set())).toBe('a');
    expect(uniqueName('a', new Set(['A']))).toBe('a-2');
    expect(uniqueName('a', new Set(['a', 'A-2']))).toBe('a-3');
  });
});

describe('existingNames', () => {
  it('lists folders under .worktrees, or nothing when it is missing', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await existingNames(repo)).toEqual(new Set());
    fs.mkdirSync(path.join(worktreesRoot(repo), 'x'), { recursive: true });
    expect(await existingNames(repo)).toEqual(new Set(['x']));
  });
});

describe('ensureExcluded', () => {
  it('adds /.worktrees/ to info/exclude once and git ignores the folder', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const commonDir = path.join(repo, '.git');
    fs.writeFileSync(path.join(commonDir, 'info', 'exclude'), '# existing\nfoo');
    expect(await ensureExcluded(commonDir)).toBe(true);
    expect(await ensureExcluded(commonDir)).toBe(false);
    expect(fs.readFileSync(path.join(commonDir, 'info', 'exclude'), 'utf8')).toBe('# existing\nfoo\n/.worktrees/\n');
    fs.mkdirSync(path.join(repo, '.worktrees', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.worktrees', 'x', 'f.txt'), 'x');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('branchNameProblem', () => {
  it('accepts normal names', () => {
    expect(branchNameProblem('feat/x', ['main'])).toBeUndefined();
  });
  it.each(['', '   '])('rejects empty %j', (name) => {
    expect(branchNameProblem(name, [])).toBe('Enter a branch name.');
  });
  it('rejects existing names', () => {
    expect(branchNameProblem('main', ['main'])).toBe("A branch named 'main' already exists.");
  });
  it.each(['a b', '-x', 'x.lock', 'a..b', 'x/', 'a//b', 'a~1', 'a:b', 'a@{1}', '.x'])('rejects invalid %j', (name) => {
    expect(branchNameProblem(name, [])).toBe(`'${name}' is not a valid branch name.`);
  });
});
