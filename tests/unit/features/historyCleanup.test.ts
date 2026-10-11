import { afterEach, describe, expect, it } from 'vitest';
import { branchStart, cleanBranchName, compareRewrite, finishRewrite, historyRef } from '../../../src/features/backlog/history';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

/** A repository whose feature/BL-2 has messy history (a mistake, its fix), with a worktree for it. */
function messyRepo() {
  const repo = initRepo();
  const wt = makeTempDir();
  cleanup.push(repo, wt);
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/BL-2', `${wt}/w`, 'main');
  const work = `${wt}/w`;
  writeFile(work, 'a.txt', 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'BL-2: Add a');
  writeFile(work, 'a.txt', 'one\ntypo\n');
  git(work, 'commit', '-qam', 'BL-2: More');
  writeFile(work, 'a.txt', 'one\ntwo\n');
  writeFile(work, 'b.txt', 'b\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'BL-2: Fix the typo, add b');
  // main moves on meanwhile.
  writeFile(repo, 'main.txt', 'main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'Other work');
  return { repo, work };
}

describe('history clean-ups', () => {
  it('names the clean branch, and finds where the branch started', async () => {
    expect(cleanBranchName('feature/BL-2', [])).toBe('feature/BL-2-clean');
    expect(cleanBranchName('feature/BL-2', ['feature/BL-2-clean', 'feature/BL-2-clean-2'])).toBe('feature/BL-2-clean-3');
    const { repo } = messyRepo();
    expect(await branchStart(repo, 'feature/BL-2', 'main')).toBe(git(repo, 'rev-parse', 'main~1'));
  });

  it('keeps the old history and moves the branch to the clean one, in its worktree', async () => {
    const { repo, work } = messyRepo();
    const base = await branchStart(repo, 'feature/BL-2', 'main');
    const oldTip = git(repo, 'rev-parse', 'feature/BL-2');
    git(repo, 'branch', 'feature/BL-2-clean', base);
    const rewrite = { branch: 'feature/BL-2', clean: 'feature/BL-2-clean', base };
    const cleanDir = makeTempDir();
    cleanup.push(cleanDir);
    git(repo, 'worktree', 'add', '-q', `${cleanDir}/c`, 'feature/BL-2-clean');
    const c = `${cleanDir}/c`;
    writeFile(c, 'a.txt', 'one\n');
    git(c, 'add', '.');
    git(c, 'commit', '-q', '-m', 'BL-2: Add a');
    // Not the same files yet: it can't be finished.
    expect((await compareRewrite(repo, rewrite)).differs).toEqual(['a.txt', 'b.txt']);
    await expect(finishRewrite(repo, { id: 'BL-2', version: 1, rewrite, worktree: work, now: new Date() })).rejects.toThrow(/2 differ/);
    expect(git(repo, 'rev-parse', 'feature/BL-2')).toBe(oldTip);

    writeFile(c, 'a.txt', 'one\ntwo\n');
    writeFile(c, 'b.txt', 'b\n');
    git(c, 'add', '.');
    git(c, 'commit', '-q', '-m', 'BL-2: Add b');
    expect(await compareRewrite(repo, rewrite)).toEqual({ differs: [], commits: 3, cleanCommits: 2 });
    // An uncommitted change in the work's worktree stays.
    writeFile(work, 'notes.txt', 'mine\n');
    const done = await finishRewrite(repo, { id: 'BL-2', version: 1, rewrite, worktree: work, now: new Date('2026-10-11T08:00:00Z') });
    expect(done).toMatchObject({ version: 1, ref: historyRef('BL-2', 1), tip: oldTip, commits: 3, cleanCommits: 2, archived: '2026-10-11T08:00:00.000Z' });
    expect(git(repo, 'rev-parse', 'feature/BL-2')).toBe(git(repo, 'rev-parse', 'feature/BL-2-clean'));
    expect(git(repo, 'rev-parse', 'refs/flotilla/history/BL-2/v1')).toBe(oldTip);
    expect(git(work, 'log', '--format=%s', 'main..HEAD')).toBe('BL-2: Add b\nBL-2: Add a');
    expect(git(work, 'status', '--porcelain')).toBe('?? notes.txt');
    // The kept history isn't a branch.
    expect(git(repo, 'branch', '--list', '*history*')).toBe('');
  });

  it('moves a branch without a worktree too, and never overwrites a kept history', async () => {
    const { repo, work } = messyRepo();
    git(repo, 'worktree', 'remove', work);
    const base = await branchStart(repo, 'feature/BL-2', 'main');
    git(repo, 'branch', 'feature/BL-2-clean', 'feature/BL-2');
    git(repo, 'reset', '-q', '--soft', 'HEAD'); // main untouched
    const rewrite = { branch: 'feature/BL-2', clean: 'feature/BL-2-clean', base };
    git(repo, 'update-ref', historyRef('BL-2', 1), 'main');
    await expect(finishRewrite(repo, { id: 'BL-2', version: 1, rewrite, now: new Date() })).rejects.toThrow();
    const done = await finishRewrite(repo, { id: 'BL-2', version: 2, rewrite, now: new Date() });
    expect(done.ref).toBe('refs/flotilla/history/BL-2/v2');
    expect(git(repo, 'rev-parse', historyRef('BL-2', 1))).toBe(git(repo, 'rev-parse', 'main'));
  });
});

describe('the clean-up prompt', () => {
  it('asks the agent to agree on the commits with the user, and to end at the same files', async () => {
    const { cleanUpPrompt } = await import('../../../src/features/backlog/history');
    const prompt = cleanUpPrompt({
      id: 'BL-2',
      ticket: '/t/BL-2.md',
      branch: 'feature/BL-2',
      clean: 'feature/BL-2-clean',
      base: 'abcdef1234567890',
      commits: 14,
      agent: 'Ada-5',
    });
    expect(prompt).toMatch(/git log --reverse --stat abcdef123456\.\.feature\/BL-2/);
    expect(prompt).toMatch(/wait for their OK/);
    expect(prompt).toMatch(/git diff feature\/BL-2` prints nothing/);
    expect(prompt).toMatch(/Agent Ada-5/);
    expect(prompt).toMatch(/don't push/);
  });
});
