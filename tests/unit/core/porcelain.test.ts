import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNameStatus, parseStatusV2, sumNumstat } from '../../../src/core/git/porcelain';
import { git, initRepo, removeDir } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('parseStatusV2', () => {
  it('parses branch headers and every entry type, including spaces in paths', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked file.txt',
      '1 D. N... 100644 000000 000000 aaa 000 gone.ts',
      '1 A. N... 000000 100644 100644 000 bbb added.ts',
      '',
    ].join('\0');
    const result = parseStatusV2(out);
    expect(result.branch).toEqual({ oid: '1234567890abcdef', head: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1 });
    expect(result.changes).toEqual([
      { path: 'src/a file.ts', kind: 'modified' },
      { path: 'new name.ts', origPath: 'old name.ts', kind: 'renamed' },
      { path: 'conflict.txt', kind: 'conflicted' },
      { path: 'untracked file.txt', kind: 'untracked' },
      { path: 'gone.ts', kind: 'deleted' },
      { path: 'added.ts', kind: 'added' },
    ]);
  });

  it('handles initial and detached heads', () => {
    const result = parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0');
    expect(result.branch).toEqual({ oid: undefined, head: undefined, ahead: 0, behind: 0 });
  });

  it('parses real git output', () => {
    const repo = initRepo();
    cleanup.push(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'new ö.txt'), 'x\n');
    const out = git(repo, 'status', '--porcelain=v2', '--branch', '-z');
    const result = parseStatusV2(out);
    expect(result.branch.head).toBe('main');
    expect(result.changes).toEqual([
      { path: 'README.md', kind: 'modified' },
      { path: 'new ö.txt', kind: 'untracked' },
    ]);
  });
});

describe('parseNameStatus', () => {
  it('parses modifications, renames, additions and deletions', () => {
    const out = ['M', 'a.ts', 'R087', 'old.ts', 'new.ts', 'A', 'b.ts', 'D', 'c.ts', 'C75', 'src.ts', 'copy.ts', ''].join('\0');
    expect(parseNameStatus(out)).toEqual([
      { path: 'a.ts', kind: 'modified' },
      { path: 'new.ts', origPath: 'old.ts', kind: 'renamed' },
      { path: 'b.ts', kind: 'added' },
      { path: 'c.ts', kind: 'deleted' },
      { path: 'copy.ts', origPath: 'src.ts', kind: 'added' },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('sumNumstat', () => {
  it('sums text changes, ignores binary files and skips rename path pairs', () => {
    const out = ['3\t1\ta.ts', '-\t-\tbin.png', '5\t0\t', 'old.ts', 'new.ts', ''].join('\0');
    expect(sumNumstat(out)).toEqual({ added: 8, deleted: 1 });
  });
});
