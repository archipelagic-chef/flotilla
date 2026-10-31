import {
  describe,
  expect,
  it,
} from 'vitest';
import type { FileChange } from '../../../../src/core/git/porcelain';
import {
  changeMarks,
  ListedFolders,
} from '../../../../src/ui/sidebar/changeMarks';

const m = (path: string): FileChange => ({ path, kind: 'modified' });

describe('the change marks of the Files tab', () => {
  it('marks the changed files in the listed folders, and the folders changes are in', () => {
    const marks = changeMarks([], [m('a.txt'), m('src/x.ts'), m('src/deep/y.ts')], new Set(['', 'src']));
    expect(marks).toEqual({ 'a.txt': 'modified', src: 'modified', 'src/x.ts': 'modified', 'src/deep': 'modified' });
  });

  it('marks nothing in folders that are not listed', () => {
    expect(changeMarks([], [m('src/deep/y.ts')], new Set(['']))).toEqual({ src: 'modified' });
    expect(changeMarks([], [m('a.txt')], new Set())).toEqual({});
  });

  it('covers every change, however many there are', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => m(`gen/f${i}.txt`));
    const marks = changeMarks([], many, new Set(['', 'gen']));
    expect(Object.keys(marks)).toHaveLength(20_001);
    expect(marks['gen/f19999.txt']).toBe('modified');
  });

  it('takes the unstaged change over the staged one: it is what is on disk', () => {
    expect(changeMarks([{ path: 'a.txt', kind: 'added' }], [m('a.txt')], new Set(['']))).toEqual({ 'a.txt': 'modified' });
  });

  it('shows new files inside a folder as a modified folder, and an untracked folder as untracked', () => {
    expect(changeMarks([], [{ path: 'src/new.ts', kind: 'untracked' }], new Set(['']))).toEqual({ src: 'modified' });
    expect(changeMarks([{ path: 'lib/n.ts', kind: 'added' }], [], new Set(['']))).toEqual({ lib: 'modified' });
    expect(changeMarks([], [{ path: 'gen/', kind: 'untracked' }], new Set(['']))).toEqual({ gen: 'untracked' });
  });

  it('gives a folder its own mark before those of the changes inside it', () => {
    const marks = changeMarks([m('dir/inner/a.txt')], [{ path: 'dir/inner/', kind: 'untracked' }], new Set(['dir']));
    expect(marks).toEqual({ 'dir/inner': 'untracked' });
  });

  it('marks a folder with a deleted file in it', () => {
    expect(changeMarks([], [{ path: 'old/gone.txt', kind: 'deleted' }], new Set(['']))).toEqual({ old: 'deleted' });
  });
});

describe('the folders a Files tab has listed', () => {
  it('remembers folders per worktree, and forgets worktrees that are gone', () => {
    const listed = new ListedFolders();
    listed.add('a', '');
    listed.add('a', 'src');
    listed.add('b', '');
    expect([...listed.of('a')]).toEqual(['', 'src']);
    listed.retain(new Set(['a']));
    expect([...listed.of('b')]).toEqual([]);
  });

  it('sends marks only when they changed since the last ones sent', () => {
    const listed = new ListedFolders();
    expect(listed.changed('a', { 'x.txt': 'modified' })).toBe(true);
    expect(listed.changed('a', { 'x.txt': 'modified' })).toBe(false);
    expect(listed.changed('a', {})).toBe(true);
    listed.clear();
    expect(listed.changed('a', {})).toBe(true);
  });
});
