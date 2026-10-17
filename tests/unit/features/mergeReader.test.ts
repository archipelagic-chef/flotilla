import { afterEach, describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { laneOf } from '../../../src/features/backlog/backlog';
import { MergeReader } from '../../../src/features/backlog/mergeReader';
import { mergeLabel, movesToDone, unmergedWarning } from '../../../src/features/backlog/merged';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const item = (id: string, extra: Partial<BacklogItem> = {}): BacklogItem => ({ id, title: id, status: 'doing', created: '', ...extra });

/** A repo on main, with a branch that has commits (not yet merged). */
function repoWith(branch: string, commits: number): string {
  const repo = initRepo();
  cleanup.push(repo);
  git(repo, 'checkout', '-q', '-b', branch);
  for (let n = 0; n < commits; n++) git(repo, 'commit', '-q', '--allow-empty', '-m', `${branch} ${n}`);
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

describe('MergeReader', () => {
  it('reports an unmerged branch with the commits the base lacks', async () => {
    const repo = repoWith('feature/BL-1-x', 2);
    const map = await new MergeReader(repo).read([item('BL-1', { branches: ['feature/BL-1-x'] })], 'main');
    expect(map.get('BL-1')).toMatchObject({ base: 'main', state: 'unmerged', commits: 2 });
    expect(mergeLabel(map.get('BL-1')!)).toBe('not merged (2 commits)');
  });

  it('reports a branch merged into the base once it has been fast-forwarded in, from the command line too', async () => {
    const repo = repoWith('feature/BL-2-x', 1);
    git(repo, 'merge', '-q', '--ff-only', 'feature/BL-2-x');
    const map = await new MergeReader(repo).read([item('BL-2', { branches: ['feature/BL-2-x'] })], 'main');
    expect(map.get('BL-2')?.state).toBe('merged');
    expect(mergeLabel(map.get('BL-2')!)).toBe('merged into main');
    expect(movesToDone(item('BL-2', { status: 'review' }), map.get('BL-2'))).toBe(true);
  });

  it("doesn't call a branch with no commits merged: a fresh branch is in the base too", async () => {
    const repo = repoWith('feature/BL-3-x', 0);
    const map = await new MergeReader(repo).read([item('BL-3', { branches: ['feature/BL-3-x'] })], 'main');
    expect(map.get('BL-3')?.state).toBe('none');
    expect(movesToDone(item('BL-3', { status: 'doing' }), map.get('BL-3'))).toBe(false);
  });

  it('reports partly merged for an epic whose branches are some merged, some not', async () => {
    const repo = repoWith('feature/BL-4-a', 1);
    git(repo, 'checkout', '-q', '-b', 'feature/BL-4-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'b');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'feature/BL-4-a');
    const map = await new MergeReader(repo).read([item('BL-4', { branches: ['feature/BL-4-a', 'feature/BL-4-b'] })], 'main');
    expect(map.get('BL-4')).toMatchObject({ state: 'partly', commits: 1 });
    expect(mergeLabel(map.get('BL-4')!)).toBe('partly merged');
    expect(unmergedWarning(item('BL-4', { status: 'done' }), map.get('BL-4'))).toBe(true);
  });

  it('finds a branch named after the item, though it was never recorded', async () => {
    const repo = repoWith('feature/BL-5-login', 1);
    const map = await new MergeReader(repo).read([item('BL-5')], 'main');
    expect(map.get('BL-5')?.branches.map((b) => b.branch)).toEqual(['feature/BL-5-login']);
  });

  it('leaves out deleted branches, and gives nothing without a base', async () => {
    const repo = repoWith('feature/BL-6-x', 1);
    git(repo, 'branch', '-D', 'feature/BL-6-x');
    expect((await new MergeReader(repo).read([item('BL-6', { branches: ['feature/BL-6-x'] })], 'main')).has('BL-6')).toBe(false);
    expect((await new MergeReader(repo).read([item('BL-7', { branches: ['feature/BL-7'] })], undefined)).size).toBe(0);
  });

  it('reads again when a branch moves, and only then', async () => {
    const repo = repoWith('feature/BL-8-x', 1);
    const reader = new MergeReader(repo);
    const items = [item('BL-8', { branches: ['feature/BL-8-x'] })];
    expect((await reader.read(items, 'main')).get('BL-8')?.commits).toBe(1);
    git(repo, 'checkout', '-q', 'feature/BL-8-x');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'more');
    git(repo, 'checkout', '-q', 'main');
    expect((await reader.read(items, 'main')).get('BL-8')?.commits).toBe(2);
  });
});

describe('lanes and warnings', () => {
  it('shows an approved item in review under Ready to Merge; other review items stay in review', () => {
    expect(laneOf({ status: 'review', review: { round: 1, state: 'approved', reviewer: 'Kit-9' } })).toBe('ready');
    expect(laneOf({ status: 'review', review: { round: 1, state: 'yours', reviewer: 'Kit-9' } })).toBe('review');
    expect(laneOf({ status: 'done' })).toBe('done');
  });

  it('warns about a Done item only while its work is unmerged and nothing superseded it', () => {
    const merge = { base: 'main', state: 'unmerged' as const, commits: 1, branches: [] };
    expect(unmergedWarning(item('BL-9', { status: 'done' }), merge)).toBe(true);
    expect(unmergedWarning(item('BL-9', { status: 'done', supersededBy: 'BL-10' }), merge)).toBe(false);
    expect(unmergedWarning(item('BL-9', { status: 'review' }), merge)).toBe(false);
  });
});
