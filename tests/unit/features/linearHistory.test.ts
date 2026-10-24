import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rebaseInDir, rebaseResult } from '../../../src/features/backlog/linearHistory';
import { fixupNote, mergeStyle, tidyNotes } from '../../../src/features/backlog/tidyNotes';
import { buildTrain, recordRebaseResolution, startTrainMerge, trainIsCurrent } from '../../../src/features/backlog/mergeTrain';
import { git, initRepo, makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function commit(repo: string, file: string, content: string, message: string): void {
  writeFile(repo, file, content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

function setup() {
  const repo = initRepo();
  const tmp = makeTempDir();
  cleanup.push(repo, tmp);
  return { repo, dir: (name: string) => path.join(tmp, name) };
}

const subjects = (repo: string, range: string) => git(repo, 'log', '--format=%s', range).split('\n').filter(Boolean);

describe('A tidy, linear history (BL-181)', () => {
  it('tidies a branch with a "Merge main" and fixups into its steps, on top of main', async () => {
    const { repo, dir } = setup();
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: Add a');
    commit(repo, 'b.txt', 'b\n', 'BL-1: Add b');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'm.txt', 'm\n', 'Main moves on');
    git(repo, 'checkout', '-q', 'feature/BL-1');
    git(repo, 'merge', '-q', '--no-edit', '-m', 'BL-1: Merge main', 'main');
    commit(repo, 'a.txt', 'a, fixed\n', 'fixup! BL-1: Add a');
    git(repo, 'checkout', '-q', 'main');
    const wt = dir('wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'feature/BL-1');

    const outcome = await rebaseInDir(wt, git(repo, 'rev-parse', 'main'));

    expect(outcome).toMatchObject({ kind: 'rebased', rebased: true });
    expect(subjects(wt, 'main..HEAD')).toEqual(['BL-1: Add b', 'BL-1: Add a']);
    expect(git(wt, 'rev-list', '--merges', '--count', 'main..HEAD')).toBe('0');
    expect(git(wt, 'show', 'HEAD:a.txt')).toBe('a, fixed');
    expect(git(wt, 'show', 'HEAD:m.txt')).toBe('m');
    expect(await rebaseResult(wt, git(repo, 'rev-parse', 'main'), 'BL-1')).toEqual({ commit: git(wt, 'rev-parse', 'HEAD'), count: 2 });
  });

  it('leaves a branch on top of main, with nothing to squash, as it is', async () => {
    const { repo, dir } = setup();
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 'a.txt', 'a\n', 'BL-1: Add a');
    const tip = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    const wt = dir('wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'feature/BL-1');
    expect(await rebaseInDir(wt, git(repo, 'rev-parse', 'main'))).toEqual({ kind: 'rebased', commit: tip, rebased: false });
  });

  it('stops on conflicts, mid-rebase, and rebaseResult says what is missing until it ends', async () => {
    const { repo, dir } = setup();
    commit(repo, 's.txt', 'one\n', 'shared');
    git(repo, 'checkout', '-q', '-b', 'feature/BL-1');
    commit(repo, 's.txt', 'two\n', 'BL-1: Two');
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 's.txt', 'three\n', 'Three');
    const main = git(repo, 'rev-parse', 'main');
    const wt = dir('wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'feature/BL-1');

    expect(await rebaseInDir(wt, main)).toEqual({ kind: 'conflicts', files: ['s.txt'] });
    expect(await rebaseResult(wt, main, 'BL-1')).toEqual({ problem: '1 file still has conflicts (s.txt).' });
    writeFile(wt, 's.txt', 'two and three\n');
    git(wt, 'add', '.');
    expect(await rebaseResult(wt, main, 'BL-1')).toMatchObject({ problem: expect.stringContaining('still in progress') });
    git(wt, '-c', 'core.editor=true', 'rebase', '--continue');
    expect(await rebaseResult(wt, main, 'BL-1')).toMatchObject({ count: 1 });
  });

  it("refuses a merge commit, or another ticket's commit, on top of the base", async () => {
    const { repo, dir } = setup();
    const main = git(repo, 'rev-parse', 'main');
    const wt = dir('wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    commit(wt, 'a.txt', 'a\n', 'BL-2: Not ours');
    expect(await rebaseResult(wt, main, 'BL-1')).toMatchObject({ problem: expect.stringContaining("doesn't start with BL-1") });
  });

  it('stacks two tickets in the train by rebasing each onto the one before: no merge commits, in order', async () => {
    const { repo, dir } = setup();
    for (const [id, file] of [['BL-1', 'a.txt'], ['BL-2', 'b.txt']]) {
      git(repo, 'checkout', '-q', '-b', `feature/${id}`, 'main');
      commit(repo, file, `${id}\n`, `${id}: Add ${file}`);
    }
    git(repo, 'checkout', '-q', 'main');
    const baseTip = git(repo, 'rev-parse', 'main');
    const entries = [
      { id: 'BL-1', branch: 'feature/BL-1', message: 'Merge BL-1' },
      { id: 'BL-2', branch: 'feature/BL-2', message: 'Merge BL-2' },
    ];

    const train = await buildTrain(repo, { dir: dir('train'), base: 'main', baseTip, entries, style: 'fast-forward' });

    expect(train.style).toBe('fast-forward');
    // BL-1 was on main already: its own tip; BL-2 rebased onto it.
    expect(train.entries[0].commit).toBe(git(repo, 'rev-parse', 'feature/BL-1'));
    expect(git(repo, 'rev-parse', `${train.entries[1].commit}^`)).toBe(train.entries[0].commit);
    expect(subjects(repo, `${baseTip}..${train.tip}`)).toEqual(['BL-2: Add b.txt', 'BL-1: Add a.txt']);
    expect(git(repo, 'rev-list', '--merges', '--count', `${baseTip}..${train.tip}`)).toBe('0');
    const tips = train.entries.map((e) => ({ id: e.id, branch: e.branch, tip: e.tip }));
    expect(trainIsCurrent(train, baseTip, tips, 'fast-forward')).toBe(true);
    // Another style: built again.
    expect(trainIsCurrent(train, baseTip, tips, 'merge-commit')).toBe(false);
  });

  it("leaves out a ticket whose rebase conflicts with the train ahead; its approved resolution is recorded and reused", async () => {
    const { repo, dir } = setup();
    commit(repo, 's.txt', 'one\n', 'shared');
    for (const [id, content] of [['BL-2', 'two\n'], ['BL-3', 'three\n']]) {
      git(repo, 'checkout', '-q', '-b', `feature/${id}`, 'main');
      commit(repo, 's.txt', content, `${id}: Change s`);
    }
    git(repo, 'checkout', '-q', 'main');
    const baseTip = git(repo, 'rev-parse', 'main');
    const entries = [
      { id: 'BL-2', branch: 'feature/BL-2', message: 'Merge BL-2' },
      { id: 'BL-3', branch: 'feature/BL-3', message: 'Merge BL-3' },
    ];
    const train = await buildTrain(repo, { dir: dir('train'), base: 'main', baseTip, entries, style: 'fast-forward' });
    expect(train.entries[1]).toMatchObject({ id: 'BL-3', conflicts: ['s.txt'] });
    expect(train.tip).toBe(train.entries[0].commit);

    // The agent resolves the rebase in the ticket's worktree in the train.
    const wt = dir('BL-3');
    expect(await startTrainMerge(repo, { dir: wt, onto: train.entries[0].commit!, branch: 'feature/BL-3', message: 'Merge BL-3', style: 'fast-forward' })).toEqual(['s.txt']);
    writeFile(wt, 's.txt', 'two and three\n');
    git(wt, 'add', '.');
    git(wt, '-c', 'core.editor=true', 'rebase', '--continue');
    const resolved = git(wt, 'rev-parse', 'HEAD');

    expect(await recordRebaseResolution(wt, { onto: train.entries[0].commit!, tip: 'refs/heads/feature/BL-3', resolved })).toEqual(['s.txt']);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(resolved);

    const again = await buildTrain(repo, { dir: dir('train2'), base: 'main', baseTip, entries, style: 'fast-forward' });
    expect(again.entries[1].commit).toBeTruthy();
    expect(git(repo, 'show', `${again.tip}:s.txt`)).toBe('two and three');
    expect(subjects(repo, `${baseTip}..${again.tip}`)).toEqual(['BL-3: Change s', 'BL-2: Change s']);
  });

  it('reads the setting, fast-forward by default', () => {
    expect(mergeStyle(undefined)).toBe('fast-forward');
    expect(mergeStyle('merge-commit')).toBe('merge-commit');
    expect(mergeStyle('nonsense')).toBe('fast-forward');
  });

  it('tells agents to rebase, tidy and make fixup! commits, and to force-push only with a lease', () => {
    const tidy = tidyNotes('BL-1');
    expect(tidy).toContain('git rebase main');
    expect(tidy).toContain('never by merging main into it');
    expect(tidy).toContain('GIT_SEQUENCE_EDITOR');
    expect(tidy).toContain('how many commits you made from how many');
    expect(tidy).toContain('--force-with-lease');
    expect(fixupNote('BL-1')).toContain('git commit --fixup');
  });
});
