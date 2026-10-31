import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  historyRows,
  searchRows,
} from '../../../src/webview/ui/rows';
import type {
  CommitView,
  SearchGroup,
} from '../../../src/webview/protocol';

const commit = (hash: string) => ({ hash, subject: hash }) as CommitView;

describe('history rows', () => {
  it('lists the commits, and an expanded one with its details and its files', () => {
    const commits = [commit('a'), commit('b')];
    const files = (hash: string) =>
      hash === 'b'
        ? {
            files: [
              { path: 'x.ts', kind: 'modified' as const },
              { path: 'y.ts', kind: 'added' as const },
            ],
          }
        : undefined;
    expect(historyRows(commits, new Set(), files).map((r) => r.key)).toEqual(['commit:a', 'commit:b']);
    expect(historyRows(commits, new Set(['b']), files).map((r) => r.key)).toEqual(['commit:a', 'commit:b', 'details:b', 'file:b:x.ts', 'file:b:y.ts']);
  });
});

describe('search rows', () => {
  const groups: SearchGroup[] = [
    {
      key: 'main',
      files: [
        { path: 'src/a.ts', matches: [{ line: 3, text: '  foo', ranges: [[2, 5]] }] },
        { path: 'b.ts', matches: [{ line: 1, text: 'foo', ranges: [[0, 3]] }] },
      ],
    },
  ];

  it('lists each file and, unless it is folded, its matching lines', () => {
    expect(searchRows(groups, new Set(), false).map((r) => r.key)).toEqual([
      'file:main\nsrc/a.ts',
      'hit:main\nsrc/a.ts\n3',
      'file:main\nb.ts',
      'hit:main\nb.ts\n1',
    ]);
    expect(searchRows(groups, new Set(['main\nsrc/a.ts']), false).map((r) => r.key)).toEqual(['file:main\nsrc/a.ts', 'file:main\nb.ts', 'hit:main\nb.ts\n1']);
  });

  it('starts each worktree with its name on the All tab', () => {
    const rows = searchRows(groups, new Set(['main\nsrc/a.ts', 'main\nb.ts']), true);
    expect(rows.map((r) => r.key)).toEqual(['ws:main', 'file:main\nsrc/a.ts', 'file:main\nb.ts']);
    expect(rows[1]).toMatchObject({ kind: 'file', count: 1, open: false });
  });
});
