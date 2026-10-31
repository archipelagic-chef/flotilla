import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  branchStart,
  conflictsOf,
  landings,
  replay,
  replayLanding,
  summarize,
} from '../../../scripts/merge-replay.mjs';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('merge-replay', () => {
  it('tells a pure addition from a change, and notes imports', () => {
    const text = [
      'a',
      '<<<<<<< ours',
      "import { x } from './x';",
      '||||||| base',
      '=======',
      "import { y } from './y';",
      '>>>>>>> theirs',
      '<<<<<<< ours',
      'one',
      '||||||| base',
      'zero',
      '=======',
      'two',
      '>>>>>>> theirs',
      '',
    ].join('\n');
    expect(conflictsOf(text).map((p) => [p.pureAddition, p.imports])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it('replays a merge in memory: two branches appending to the same list conflict, as a pure addition', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-replay-'));
    temps.push(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'list.txt'), 'a\nb\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'x');
    fs.appendFileSync(path.join(repo, 'list.txt'), 'x\n');
    git('commit', '-qam', 'x');
    git('checkout', '-q', 'main');
    fs.appendFileSync(path.join(repo, 'list.txt'), 'y\n');
    git('commit', '-qam', 'y');
    const files = replay(repo, 'main', 'x');
    expect(files?.map((f) => f.name)).toEqual(['list.txt']);
    expect(summarize([{ commit: 'm', files }, { commit: 'n' }])).toMatchObject({ merges: 2, conflicted: 1, places: 1, pureAdditions: 1 });
  });

  it('replays a ticket that landed as a straight line: against what landed since its branch was created', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flotilla-replay-'));
    temps.push(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    const append = (line: string, message: string) => {
      fs.appendFileSync(path.join(repo, 'list.txt'), `${line}\n`);
      git('commit', '-qam', message);
    };
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'list.txt'), 'a\nb\n');
    git('add', '.');
    git('commit', '-qm', 'BL-1: base');
    git('branch', '-q', 'feature/BL-3-x');
    git('branch', '-q', 'feature/BL-4-z');
    // BL-2 lands; then BL-3, started before it, lands rebased on it (as its resolved rebase left it): its rebase met
    // BL-2's line.
    append('y', 'BL-2: y');
    append('x', 'BL-3: x');
    append('x2', 'BL-3: x2');
    // BL-4 changed another file: clean.
    git('checkout', '-q', 'feature/BL-4-z');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'z\n');
    git('add', '.');
    git('commit', '-qm', 'BL-4: z');
    git('rebase', '-q', 'main');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--ff-only', 'feature/BL-4-z');

    const runs = landings(repo, 'main', '2000-01-01');
    expect(runs.map((r) => r.id)).toEqual(['BL-1', 'BL-2', 'BL-3', 'BL-4']);
    expect(branchStart(repo, 'BL-3')).toBe(git('rev-parse', 'main~4'));
    expect(branchStart(repo, 'BL-2')).toBeUndefined();
    const [bl3, bl4] = runs.slice(2).map((r) => replayLanding(repo, r, branchStart(repo, r.id)!));
    expect(bl3?.map((f) => f.name)).toEqual(['list.txt']);
    expect(bl3?.[0].places.map((p) => p.pureAddition)).toEqual([true]);
    expect(bl4).toBeUndefined();
  });
});
