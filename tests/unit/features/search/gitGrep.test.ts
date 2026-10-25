import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  highlight,
  matcher,
  parseGrep,
  searchWorktree,
} from '../../../../src/features/search/gitGrep';
import {
  git,
  initRepo,
  removeDir,
  writeFile,
} from '../../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));
const plain = { matchCase: false, wholeWord: false, regex: false };

describe('matcher and highlight', () => {
  it('finds literal, case-sensitive, whole-word and regex matches', () => {
    expect(highlight('Retry retry RETRY', matcher('retry', plain)!).ranges).toEqual([
      [0, 5],
      [6, 11],
      [12, 17],
    ]);
    expect(highlight('Retry retry', matcher('retry', { ...plain, matchCase: true })!).ranges).toEqual([[6, 11]]);
    expect(highlight('retry retrying', matcher('retry', { ...plain, wholeWord: true })!).ranges).toEqual([[0, 5]]);
    expect(highlight('a.b axb', matcher('a.b', plain)!).ranges).toEqual([[0, 3]]);
    expect(highlight('a1 a22', matcher('a[0-9]+', { ...plain, regex: true })!).ranges).toEqual([
      [0, 2],
      [3, 6],
    ]);
    expect(matcher('(', { ...plain, regex: true })).toBeUndefined();
  });

  it('shortens long lines around the first match and keeps the ranges aligned', () => {
    const line = `${'x'.repeat(500)}needle${'y'.repeat(500)}`;
    const { text, ranges } = highlight(line, matcher('needle', plain)!);
    expect(text.length).toBeLessThanOrEqual(241);
    expect(text.startsWith('…')).toBe(true);
    expect(text.slice(ranges[0][0], ranges[0][1])).toBe('needle');
  });
});

describe('parseGrep', () => {
  it('groups matches by file and stops at the limit', () => {
    const out = ['a.ts\u00001\u0000retry here', 'a.ts\u00004\u0000retry again', 'b.ts\u00002\u0000no retry'].join('\n') + '\n';
    const result = parseGrep(out, matcher('retry', plain)!, 2);
    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([
      {
        path: 'a.ts',
        matches: [
          { line: 1, text: 'retry here', ranges: [[0, 5]] },
          { line: 4, text: 'retry again', ranges: [[0, 5]] },
        ],
      },
    ]);
  });
});

describe('searchWorktree', () => {
  it('searches tracked and untracked files but not ignored ones or other worktrees', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, 'src/client.ts', 'export const retry = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'client');
    writeFile(repo, 'notes.txt', 'remember to Retry\n');
    writeFile(repo, '.gitignore', 'dist/\n');
    writeFile(repo, 'dist/out.js', 'retry\n');
    git(repo, 'worktree', 'add', '-q', '-b', 'a', path.join(repo, '.worktrees', 'a'));
    writeFile(repo, '.git/info/exclude', '/.worktrees/\n');

    const result = await searchWorktree(repo, 'retry', plain);
    expect(result.files.map((f) => f.path).sort()).toEqual(['notes.txt', 'src/client.ts']);
    expect((await searchWorktree(repo, 'retry', { ...plain, matchCase: true })).files.map((f) => f.path)).toEqual(['src/client.ts']);
    expect(await searchWorktree(repo, 'nothing-matches-this', plain)).toEqual({ files: [], truncated: false });
    expect(await searchWorktree(repo, '', plain)).toEqual({ files: [], truncated: false });
  });
});

describe('replaceAll', () => {
  it('replaces literally, with case and whole-word options, and with regex groups', async () => {
    const { replaceAll } = await import('../../../../src/features/search/matcher');
    expect(replaceAll('retry Retry retrying', 'retry', 'again', plain)).toEqual({ text: 'again again againing', count: 3 });
    expect(replaceAll('retry Retry', 'retry', 'x', { ...plain, matchCase: true })).toEqual({ text: 'x Retry', count: 1 });
    expect(replaceAll('retry retrying', 'retry', 'x', { ...plain, wholeWord: true })).toEqual({ text: 'x retrying', count: 1 });
    expect(replaceAll('a1 b22', '([a-z])([0-9]+)', '$2$1', { ...plain, regex: true })).toEqual({ text: '1a 22b', count: 2 });
    // Literal mode inserts "$1" as typed.
    expect(replaceAll('cost', 'cost', '$1', plain)).toEqual({ text: '$1', count: 1 });
    expect(replaceAll('x', '(', 'y', { ...plain, regex: true })).toEqual({ text: 'x', count: 0 });
  });
});
