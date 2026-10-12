import { describe, expect, it } from 'vitest';
import { treeRows, type TreeState } from '../../../src/webview/ui/treeRows';
import type { DirEntry } from '../../../src/webview/protocol';

const dir = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, dir: true, ...extra });
const file = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, dir: false, ...extra });

function tree(listings: Record<string, DirEntry[]>, state: Partial<TreeState> = {}): ReturnType<typeof treeRows> {
  return treeRows({ entries: (path) => listings[path], open: new Set(), ...state });
}

describe('the Files tree rows', () => {
  const listings = {
    '': [dir('src'), file('README.md')],
    src: [file('a.ts'), dir('lib')],
    'src/lib': [file('b.ts', { ignored: true })],
  };

  it('shows the top folder, and what is in the folders opened', () => {
    expect(tree(listings).map((r) => r.key)).toEqual(['entry:src', 'entry:README.md']);
    expect(tree(listings, { open: new Set(['src', 'src/lib']) }).map((r) => r.key)).toEqual([
      'entry:src',
      'entry:src/a.ts',
      'entry:src/lib',
      'entry:src/lib/b.ts',
      'entry:README.md',
    ]);
  });

  it('passes the ignored state down to what is in an ignored folder', () => {
    const ignored = { '': [dir('build', { ignored: true })], build: [file('out.js')] };
    const rows = tree(ignored, { open: new Set(['build']) });
    expect(rows.map((r) => (r.kind === 'entry' ? [r.path, r.ignored] : r.kind))).toEqual([
      ['build', true],
      ['build/out.js', true],
    ]);
  });

  it('shows a loading row for a folder not read yet, and a name box once it is read', () => {
    const state = { open: new Set(['src']), create: { dir: 'src', kind: 'file' as const } };
    expect(tree({ '': [dir('src')] }, state).map((r) => r.key)).toEqual(['entry:src', 'loading:src']);
    expect(tree({ '': [dir('src')], src: [file('a.ts')] }, state).map((r) => r.key)).toEqual(['entry:src', 'create:src', 'entry:src/a.ts']);
    expect(tree({ '': [] })).toEqual([{ key: 'empty', kind: 'empty' }]);
  });

  it('puts a name box for a new top-level folder first, and a rename where its row is', () => {
    const rows = tree({ '': [file('a.txt'), file('b.txt')] }, { create: { dir: '', kind: 'folder' }, rename: { path: 'b.txt', error: 'taken' } });
    expect(rows.map((r) => r.key)).toEqual(['create:', 'entry:a.txt', 'rename:b.txt']);
    expect(rows[2]).toMatchObject({ kind: 'rename', error: 'taken' });
  });
});
