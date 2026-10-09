import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makePortable } from '../../../src/features/worktrees/portability';
import { resolveWorktrees, type ResolvedWorktree } from '../../../src/features/worktrees/resolver';
import { expectSamePath, git, initRepo, makeTempDir, removeDir, simulateOtherEnvironment } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const roots = (repo: string) => ({ mainRoot: repo, commonDir: path.join(repo, '.git') });
const byId = (list: ResolvedWorktree[], id: string) => list.find((w) => w.id === id)!;

describe('resolveWorktrees', () => {
  it('returns only the main worktree for a fresh repo', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const list = await resolveWorktrees(roots(repo));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: undefined, isMain: true, branch: 'main', portable: true, insideRepo: false });
    expectSamePath(list[0].path, repo);
  });

  it('resolves inside, outside and detached worktrees', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    cleanup.push(repo, outsideParent);
    git(repo, 'worktree', 'add', '-b', 'in', path.join(repo, '.worktrees', 'in'));
    git(repo, 'worktree', 'add', '-b', 'out', path.join(outsideParent, 'out'));
    git(repo, 'worktree', 'add', '--detach', path.join(repo, '.worktrees', 'det'), 'HEAD');

    const list = await resolveWorktrees(roots(repo));
    expect(list.map((w) => w.id)).toEqual([undefined, 'det', 'in', 'out']);
    expect(byId(list, 'in')).toMatchObject({ branch: 'in', insideRepo: true, portable: false, locked: false });
    expectSamePath(byId(list, 'in').path, path.join(repo, '.worktrees', 'in'));
    expect(byId(list, 'out')).toMatchObject({ branch: 'out', insideRepo: false });
    expect(byId(list, 'det').branch).toBeUndefined();
    expect(byId(list, 'det').head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('finds portable worktrees through the .worktrees scan in another environment and marks others unreachable', async () => {
    const repo = initRepo();
    const outsideParent = makeTempDir();
    const inDir = path.join(repo, '.worktrees', 'in');
    git(repo, 'worktree', 'add', '-b', 'in', inDir);
    await makePortable(inDir, path.join(repo, '.git', 'worktrees', 'in'));
    git(repo, 'worktree', 'add', '-b', 'out', path.join(outsideParent, 'out'));
    const other = simulateOtherEnvironment(repo);
    cleanup.push(other, `${repo}-gone`, outsideParent);

    const list = await resolveWorktrees(roots(other));
    const inWt = byId(list, 'in');
    expectSamePath(inWt.path, path.join(other, '.worktrees', 'in'));
    expect(inWt).toMatchObject({ portable: true, locked: true, insideRepo: true });
    expectSamePath(inWt.recordedPath, inDir);
    const outWt = byId(list, 'out');
    expect(outWt.path).toBeUndefined();
    expectSamePath(outWt.recordedPath, path.join(outsideParent, 'out'));
  });
});
