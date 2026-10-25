import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { mergeRoot } from '../../../src/features/backlog/merge';
import {
  buildTrain,
  dequeue,
  enqueue,
  landing,
  lastInTrain,
  ordinal,
  queuedItems,
  recordResolution,
  startTrainMerge,
  TRAIN_BRANCH,
  trainIsCurrent,
  trainOnto,
  trainState,
} from '../../../src/features/backlog/mergeTrain';
import {
  git,
  initRepo,
  makeTempDir,
  removeDir,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const approved = (id: string, extra: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title: `Item ${id}`,
  status: 'review',
  created: '',
  review: { round: 1, reviewer: 'Rex-1', state: 'approved' } as BacklogItem['review'],
  ...extra,
});

function commit(repo: string, file: string, content: string, message: string): void {
  writeFile(repo, file, content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

/** main with shared.txt; BL-1 adds a.txt, BL-2 and BL-3 both change shared.txt's line (they conflict). */
function setup(): { repo: string; tmp: string } {
  const repo = initRepo();
  const tmp = makeTempDir();
  cleanup.push(repo, tmp);
  commit(repo, 'shared.txt', 'one\n', 'shared');
  const branch = (name: string, file: string, content: string) => {
    git(repo, 'checkout', '-q', '-b', name, 'main');
    commit(repo, file, content, `${name.slice(8)}: change ${file}`);
  };
  branch('feature/BL-1', 'a.txt', 'a\n');
  branch('feature/BL-2', 'shared.txt', 'two\n');
  branch('feature/BL-3', 'shared.txt', 'three\n');
  git(repo, 'checkout', '-q', 'main');
  return { repo, tmp };
}

const entries = (...ids: string[]) => ids.map((id) => ({ id, branch: `feature/${id}`, message: `Merge ${id}: Item ${id}` }));
const dir = (tmp: string, n: string) => path.join(mergeRoot(tmp), `train-${n}`);
const rev = (repo: string, ref: string) => git(repo, 'rev-parse', ref).trim();

describe('the merge queue', () => {
  it('keeps its order, adds at the end once, and drops what is not ready to merge', () => {
    expect(enqueue(['BL-2'], ['BL-1', 'BL-2', 'BL-3'])).toEqual(['BL-2', 'BL-1', 'BL-3']);
    expect(dequeue(['BL-2', 'BL-1'], ['BL-2'])).toEqual(['BL-1']);
    const items = [approved('BL-1'), approved('BL-2', { status: 'done' }), approved('BL-3')];
    expect(queuedItems({ items, mergeQueue: ['BL-3', 'BL-2', 'BL-1', 'BL-9'] }).map((i) => i.id)).toEqual(['BL-3', 'BL-1']);
  });

  it('says places', () => {
    expect([1, 2, 3, 4, 11, 12, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '21st', '22nd']);
  });
});

describe('the train', () => {
  it('merges each ticket on the one before, in order, and lands up to one by moving main to its merge commit', async () => {
    const { repo, tmp } = setup();
    const baseTip = rev(repo, 'main');
    const train = await buildTrain(repo, { dir: dir(tmp, '1'), base: 'main', baseTip, entries: entries('BL-1', 'BL-2') });
    expect(train.entries.map((e) => [e.id, !!e.commit, e.conflicts])).toEqual([
      ['BL-1', true, undefined],
      ['BL-2', true, undefined],
    ]);
    expect(rev(repo, TRAIN_BRANCH)).toBe(train.tip);
    // One merge commit per ticket on the first-parent line, each ticket's commits on its second parent.
    expect(git(repo, 'log', '--first-parent', '--format=%s', `${baseTip}..${train.tip}`).trim().split('\n')).toEqual([
      'Merge BL-2: Item BL-2',
      'Merge BL-1: Item BL-1',
    ]);
    expect(rev(repo, `${train.entries[1].commit}^1`)).toBe(train.entries[0].commit);
    expect(rev(repo, `${train.entries[0].commit}^2`)).toBe(rev(repo, 'feature/BL-1'));
    expect(trainState(train, 'BL-2')).toBe('Merges cleanly onto main + BL-1.');
    expect(landing(train, 'BL-1')).toEqual({ commit: train.entries[0].commit, lands: [train.entries[0]] });
    expect(landing(train, 'BL-2')?.lands.map((e) => e.id)).toEqual(['BL-1', 'BL-2']);
    expect(lastInTrain(train)?.id).toBe('BL-2');
    expect(trainIsCurrent(train, baseTip, train.entries)).toBe(true);
    expect(trainIsCurrent(train, rev(repo, 'feature/BL-1'), train.entries)).toBe(false);
  });

  it('leaves a ticket that conflicts with the train ahead out, and merges the ones behind it as if it were not there', async () => {
    const { repo, tmp } = setup();
    const train = await buildTrain(repo, { dir: dir(tmp, '2'), base: 'main', baseTip: rev(repo, 'main'), entries: entries('BL-2', 'BL-3', 'BL-1') });
    expect(train.entries.map((e) => [e.id, e.conflicts])).toEqual([
      ['BL-2', undefined],
      ['BL-3', ['shared.txt']],
      ['BL-1', undefined],
    ]);
    expect(rev(repo, `${train.entries[2].commit}^1`)).toBe(train.entries[0].commit);
    expect(trainState(train, 'BL-3')).toBe('Conflicts with main + BL-2 in `shared.txt`.');
    expect(landing(train, 'BL-3')).toBeUndefined();
    expect(landing(train, 'BL-1')?.lands.map((e) => e.id)).toEqual(['BL-2', 'BL-1']);
    // Removed from the queue: rebuilt without it, nothing reverted.
    const without = await buildTrain(repo, { dir: dir(tmp, '3'), base: 'main', baseTip: rev(repo, 'main'), entries: entries('BL-2', 'BL-1') });
    expect(without.entries.every((e) => e.commit)).toBe(true);
  });

  it('reuses a resolution recorded before (rerere) when the train is rebuilt', async () => {
    const { repo, tmp } = setup();
    // A resolution of BL-3 onto BL-2, recorded once by hand in a merge with rerere on.
    git(repo, 'checkout', '-q', '-b', 'resolve', 'feature/BL-2');
    try {
      git(repo, '-c', 'rerere.enabled=true', 'merge', '--no-ff', '-q', 'feature/BL-3');
    } catch {
      // The conflict, as expected.
    }
    writeFile(repo, 'shared.txt', 'two and three\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'rerere.enabled=true', 'commit', '-q', '--no-edit');
    git(repo, 'checkout', '-q', 'main');
    const train = await buildTrain(repo, { dir: dir(tmp, '4'), base: 'main', baseTip: rev(repo, 'main'), entries: entries('BL-2', 'BL-3') });
    expect(train.entries.map((e) => [e.id, !!e.commit, !!e.reused])).toEqual([
      ['BL-2', true, false],
      ['BL-3', true, true],
    ]);
    expect(git(repo, 'show', `${train.tip}:shared.txt`)).toBe('two and three');
  });

  it("resolves a conflict between the 2nd and 3rd ticket once, in the entry's merge in the train, and reuses it on every rebuild", async () => {
    const { repo, tmp } = setup();
    const baseTip = rev(repo, 'main');
    const tip3 = rev(repo, 'feature/BL-3');
    const first = await buildTrain(repo, { dir: dir(tmp, '5'), base: 'main', baseTip, entries: entries('BL-1', 'BL-2', 'BL-3') });
    expect(first.entries[2].conflicts).toEqual(['shared.txt']);
    const onto = trainOnto(first, 'BL-3')!;
    expect(onto).toEqual({ commit: first.entries[1].commit, ahead: ['BL-1', 'BL-2'] });
    // The agent's worktree: at the train's commit before BL-3, its merge in progress.
    const work = dir(tmp, 'resolve');
    expect(await startTrainMerge(repo, { dir: work, onto: onto.commit, branch: 'feature/BL-3', message: 'Merge BL-3: Item BL-3' })).toEqual(['shared.txt']);
    // It resolves and commits the merge as git is configured (no rerere).
    writeFile(work, 'shared.txt', 'two and three\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '--no-edit');
    const resolved = rev(work, 'HEAD');
    expect(await recordResolution(work, { onto: onto.commit, tip: 'feature/BL-3', resolved, message: 'Merge BL-3: Item BL-3' })).toEqual(['shared.txt']);
    expect(rev(work, 'HEAD')).toBe(resolved);
    git(repo, 'worktree', 'remove', '--force', work);
    for (const n of ['6', '7']) {
      const train = await buildTrain(repo, { dir: dir(tmp, n), base: 'main', baseTip, entries: entries('BL-1', 'BL-2', 'BL-3') });
      expect(train.entries.map((e) => [e.id, !!e.commit, !!e.reused])).toEqual([
        ['BL-1', true, false],
        ['BL-2', true, false],
        ['BL-3', true, true],
      ]);
      expect(trainState(train, 'BL-3')).toBe('Merges cleanly onto main + BL-1 + BL-2 (with a resolution recorded before).');
      expect(git(repo, 'show', `${train.tip}:shared.txt`)).toBe('two and three');
    }
    // Its branch wasn't changed, and nothing was merged into it.
    expect(rev(repo, 'feature/BL-3')).toBe(tip3);
  });
});
