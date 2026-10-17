import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { describeChanges } from '../../../src/features/backlog/changes';
import {
  blockingItems,
  checkBranch,
  defaultCheckCommand,
  fastForward,
  hasUncommittedChanges,
  idsIn,
  isMergeDir,
  linkDependencies,
  localBase,
  mergeInWorktree,
  mergeMessage,
  mergeOrder,
  mergeResult,
  mergeRoot,
  removeMergeWorktree,
  resolvePrompt,
} from '../../../src/features/backlog/merge';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const item = (id: string, status: BacklogItem['status'] = 'doing', extra: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title: `Item ${id}`,
  status,
  created: '',
  ...extra,
});

function commit(repo: string, file: string, content: string, message: string): void {
  writeFile(repo, file, content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

/** A repository with a branch for BL-1 off main, and a temp folder for merge worktrees. */
function setup(): { repo: string; tmp: string } {
  const repo = initRepo();
  const tmp = makeTempDir();
  cleanup.push(repo, tmp);
  git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
  commit(repo, 'a.txt', 'a\n', 'BL-1: add a');
  git(repo, 'checkout', '-q', 'main');
  return { repo, tmp };
}

describe('merge messages and ids', () => {
  it('names the ticket in the merge message', () => {
    expect(mergeMessage({ id: 'BL-12', title: 'Fix login' })).toBe('Merge BL-12: Fix login');
  });

  it('finds whole ids only', () => {
    expect(idsIn('BL-12: fix\nsee bl-3', ['BL-1', 'BL-12', 'BL-3'])).toEqual(['BL-12', 'BL-3']);
  });

  it('blocks on other tickets that are not done, not on its own, its parts or done ones', () => {
    const items = [item('BL-1'), item('BL-2'), item('BL-3', 'done'), item('BL-4', 'doing', { parent: 'BL-1' }), item('BL-5', 'review')];
    const messages = ['BL-1: start', 'BL-2: borrowed', 'BL-3: finished', 'BL-4: part', 'BL-5: in review'];
    expect(blockingItems(items[0], messages, items).map((i) => i.id)).toEqual(['BL-2', 'BL-5']);
  });

  it('notes a merge in the activity', () => {
    const before = item('BL-1', 'review');
    const after = { ...before, status: 'done' as const, merged: { into: 'main', commit: 'abcdef1234', date: '' } };
    expect(describeChanges(before, after, 'Flotilla')).toEqual(['Merged it into **main** (abcdef1).', 'Moved it from **In Review** to **Done**.']);
  });
});

describe('mergeOrder', () => {
  it('puts a branch after the ones it contains, otherwise keeps the order', () => {
    // c contains b, b contains a.
    const contains = (x: string, y: string) => (x === 'c' && (y === 'b' || y === 'a')) || (x === 'b' && y === 'a');
    expect(mergeOrder(['c', 'd', 'b', 'a'], contains)).toEqual(['d', 'a', 'b', 'c']);
    expect(mergeOrder(['x', 'y'], () => false)).toEqual(['x', 'y']);
  });

  it('ends even in a cycle', () => {
    expect(mergeOrder(['a', 'b'], () => true)).toEqual(['a', 'b']);
  });
});

describe('defaultCheckCommand', () => {
  it('runs typecheck and test when package.json has them', () => {
    expect(defaultCheckCommand(JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest run', build: 'x' } }))).toBe('npm run typecheck && npm test');
    expect(defaultCheckCommand(JSON.stringify({ scripts: { test: 'jest' } }), ['yarn.lock'])).toBe('yarn test');
    expect(defaultCheckCommand(JSON.stringify({ scripts: { typecheck: 'tsc' } }), ['pnpm-lock.yaml'])).toBe('pnpm typecheck');
  });

  it('has none without them', () => {
    expect(defaultCheckCommand(undefined)).toBeUndefined();
    expect(defaultCheckCommand('{ not json')).toBeUndefined();
    expect(defaultCheckCommand(JSON.stringify({ scripts: { build: 'x' } }))).toBeUndefined();
  });
});

describe('merge dirs', () => {
  it('accepts only folders right under the merge root', () => {
    const tmp = path.resolve('/tmp-x');
    expect(isMergeDir(path.join(mergeRoot(tmp), 'repo-BL-1-abc'), tmp)).toBe(true);
    expect(isMergeDir(mergeRoot(tmp), tmp)).toBe(false);
    expect(isMergeDir(path.join(mergeRoot(tmp), '..', 'home'), tmp)).toBe(false);
    expect(isMergeDir(path.join(mergeRoot(tmp), 'a', 'b'), tmp)).toBe(false);
    expect(isMergeDir(path.resolve('/home/me'), tmp)).toBe(false);
  });
});

describe('checkBranch', () => {
  it('lists the commits to merge', async () => {
    const { repo } = setup();
    const check = await checkBranch(repo, 'main', 'feature/BL-1');
    expect(check.commits.map((c) => c.message)).toEqual(['BL-1: add a']);
    expect(check.merged).toBe(false);
    expect(check.superseded).toBe(false);
    expect(await localBase(repo, 'origin/main')).toBe('main');
    expect(await localBase(repo, 'nope')).toBeUndefined();
  });

  it('says when base has the same changes already (superseded), or all its commits (merged)', async () => {
    const { repo } = setup();
    commit(repo, 'a.txt', 'a\n', 'BL-2: the same change, elsewhere');
    expect((await checkBranch(repo, 'main', 'feature/BL-1')).superseded).toBe(true);
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature/BL-1');
    expect((await checkBranch(repo, 'main', 'feature/BL-1')).merged).toBe(true);
  });
});

describe('merging in a temporary worktree', () => {
  it('merges with --no-ff, and fast-forwards a checked-out base without touching the user', async () => {
    const { repo, tmp } = setup();
    const baseTip = git(repo, 'rev-parse', 'main');
    const dir = path.join(mergeRoot(tmp), 'm1');
    const out = await mergeInWorktree(repo, { dir, baseTip, branch: 'feature/BL-1', message: 'Merge BL-1: Item' });
    expect(out.kind).toBe('merged');
    const commit = (out as { commit: string }).commit;
    expect(git(repo, 'log', '-1', '--format=%s', commit)).toBe('Merge BL-1: Item');
    expect(git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ')).toHaveLength(3);
    expect(git(repo, 'log', '-1', '--format=%an', commit)).toBe('Test');
    // main hasn't moved yet.
    expect(git(repo, 'rev-parse', 'main')).toBe(baseTip);
    expect(await hasUncommittedChanges(repo)).toBe(false);
    await fastForward(repo, { base: 'main', baseTip, commit, worktree: repo, message: 'Merge BL-1: Item' });
    expect(git(repo, 'rev-parse', 'main')).toBe(commit);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    await removeMergeWorktree(repo, dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('m1');
  });

  it('moves a base no worktree has, only from where it was', async () => {
    const { repo, tmp } = setup();
    git(repo, 'checkout', '-q', '--detach');
    const baseTip = git(repo, 'rev-parse', 'main');
    const dir = path.join(mergeRoot(tmp), 'm2');
    const out = (await mergeInWorktree(repo, { dir, baseTip, branch: 'feature/BL-1', message: 'Merge BL-1: Item' })) as { commit: string };
    commit(repo, 'b.txt', 'b\n', 'elsewhere');
    git(repo, 'branch', '-f', 'main', 'HEAD');
    await expect(fastForward(repo, { base: 'main', baseTip, commit: out.commit, message: 'm' })).rejects.toThrow(/moved since/);
    git(repo, 'branch', '-f', 'main', baseTip);
    await fastForward(repo, { base: 'main', baseTip, commit: out.commit, message: 'm' });
    expect(git(repo, 'rev-parse', 'main')).toBe(out.commit);
    await removeMergeWorktree(repo, dir);
  });

  it('leaves conflicts to resolve, and takes the resolution once committed', async () => {
    const { repo, tmp } = setup();
    commit(repo, 'a.txt', 'other\n', 'BL-2: a differently');
    const baseTip = git(repo, 'rev-parse', 'main');
    const dir = path.join(mergeRoot(tmp), 'm3');
    const out = await mergeInWorktree(repo, { dir, baseTip, branch: 'feature/BL-1', message: 'Merge BL-1: Item' });
    expect(out).toEqual({ kind: 'conflicts', files: ['a.txt'] });
    // The user's worktree isn't mid-merge.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(await mergeResult(dir, baseTip)).toEqual({ problem: expect.stringContaining('a.txt') });
    writeFile(dir, 'a.txt', 'a\nother\n');
    git(dir, 'add', 'a.txt');
    // Resolved, not committed: committed with the merge's message.
    const result = (await mergeResult(dir, baseTip)) as { commit: string };
    expect(git(repo, 'log', '-1', '--format=%s', result.commit)).toBe('Merge BL-1: Item');
    await removeMergeWorktree(repo, dir);
  });

  it('cancels a merge with conflicts, leaving nothing behind', async () => {
    const { repo, tmp } = setup();
    commit(repo, 'a.txt', 'other\n', 'BL-2: a differently');
    const baseTip = git(repo, 'rev-parse', 'main');
    const dir = path.join(mergeRoot(tmp), 'm4');
    await mergeInWorktree(repo, { dir, baseTip, branch: 'feature/BL-1', message: 'm' });
    await removeMergeWorktree(repo, dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo, 'rev-parse', 'main')).toBe(baseTip);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('links node_modules for the checks, and removes only the link', async () => {
    const { repo, tmp } = setup();
    commit(repo, 'package.json', '{}\n', 'package');
    writeFile(repo, 'node_modules/dep/index.js', 'x\n');
    const baseTip = git(repo, 'rev-parse', 'main');
    const dir = path.join(mergeRoot(tmp), 'm5');
    await mergeInWorktree(repo, { dir, baseTip, branch: 'feature/BL-1', message: 'm' });
    const link = await linkDependencies(dir, repo);
    expect(link).toBeDefined();
    expect(fs.existsSync(path.join(dir, 'node_modules', 'dep', 'index.js'))).toBe(true);
    await removeMergeWorktree(repo, dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });
});

describe('resolvePrompt', () => {
  it('gives both tickets, both sides and the checks', () => {
    const prompt = resolvePrompt({
      item: { id: 'BL-1', title: 'One' },
      agent: 'Nova-7',
      ticket: '/b/BL-1.md',
      branch: 'feature/BL-1',
      base: 'main',
      start: 'abcdef1234567890',
      files: ['a.txt'],
      description: 'Do one.',
      theirs: ['111 BL-1: add a'],
      ours: ['222 BL-2: a differently'],
      others: [{ id: 'BL-2', title: 'Two', description: 'Do two.' }],
      checks: 'npm test',
    });
    expect(prompt).toContain('> Do one.');
    expect(prompt).toContain('BL-2 "Two"');
    expect(prompt).toContain('> Do two.');
    expect(prompt).toContain('- 222 BL-2: a differently');
    expect(prompt).toContain('`npm test`');
    expect(prompt).toContain('git commit --no-edit');
    expect(prompt).toContain('Agent Nova-7');
  });
});
