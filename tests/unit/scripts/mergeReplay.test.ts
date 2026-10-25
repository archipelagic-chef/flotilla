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
import { conflictsOf, replay, summarize } from '../../../scripts/merge-replay.mjs';

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
});
