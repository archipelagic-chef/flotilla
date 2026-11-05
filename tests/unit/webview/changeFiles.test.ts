import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  biggestFiles,
  changeLetter,
  changeLink,
} from '../../../src/webview/ticket/changeFiles';
import type {
  ChangedFile,
  ChangeGroup,
  TicketChange,
} from '../../../src/webview/ticketProtocol';

const file = (p: string, added = 1, deleted = 0): ChangedFile => ({ path: p, kind: 'modified', added, deleted });
const group = (label: string, files: ChangedFile[]): ChangeGroup => ({
  label,
  dir: '/r',
  left: 'a',
  right: 'b',
  compared: label,
  files,
  added: files.reduce((n, f) => n + f.added, 0),
  deleted: 0,
  uncommitted: 0,
});
const change = (...groups: ChangeGroup[]): TicketChange => ({ stage: 'work', groups, files: 0, added: 0, deleted: 0 });

describe('changeLink', () => {
  const c = change(group('api', [file('src/x.ts')]), group('ui', [file('src/x.ts'), file('src/my file.ts')]));

  it('a link to a changed file: its group (the first that has it) and line', () => {
    expect(changeLink('src/x.ts#L42', c)).toEqual({ group: 0, path: 'src/x.ts', line: 42 });
    expect(changeLink('src/x.ts#L42-L60', c)).toEqual({ group: 0, path: 'src/x.ts', line: 42 });
    expect(changeLink('./src/x.ts:7', c)).toEqual({ group: 0, path: 'src/x.ts', line: 7 });
    expect(changeLink('src/my%20file.ts', c)).toEqual({ group: 1, path: 'src/my file.ts' });
  });

  it('other files, web links and anchors: none', () => {
    expect(changeLink('src/y.ts#L1', c)).toBeUndefined();
    expect(changeLink('https://example.com/src/x.ts', c)).toBeUndefined();
    expect(changeLink('#2026-10-20-1604-you', c)).toBeUndefined();
    expect(changeLink('src/x.ts', undefined)).toBeUndefined();
  });
});

describe('biggestFiles', () => {
  it('the files with the most lines changed, and how many more there are', () => {
    const c = change(group('one', [file('a.ts', 1), file('b.ts', 10, 2), file('c.ts', 4), file('d.ts', 3, 3)]));
    const { files, more } = biggestFiles(c);
    expect(files.map((f) => f.file.path)).toEqual(['b.ts', 'd.ts', 'c.ts']);
    expect(files[0]).toEqual({ group: 0, file: file('b.ts', 10, 2) });
    expect(more).toBe(1);
  });

  it('a binary file comes last; a short list has no more', () => {
    const c = change(group('one', [{ ...file('logo.png', 0), binary: true }, file('a.ts', 1)]));
    expect(biggestFiles(c)).toEqual({
      files: [
        { group: 0, file: file('a.ts', 1) },
        { group: 0, file: { ...file('logo.png', 0), binary: true } },
      ],
      more: 0,
    });
  });

  it('with two branches, each file says its branch, and one changed on both is listed once, the bigger', () => {
    const c = change(group('api', [file('src/x.ts', 2)]), group('ui', [file('src/x.ts', 5), file('src/y.ts', 1)]));
    expect(biggestFiles(c)).toEqual({
      files: [
        { group: 1, file: file('src/x.ts', 5), branch: 'ui' },
        { group: 1, file: file('src/y.ts', 1), branch: 'ui' },
      ],
      more: 0,
    });
  });
});

describe('changeLetter', () => {
  it('as Source Control shows it', () => {
    expect(['added', 'untracked', 'deleted', 'renamed', 'modified'].map((kind) => changeLetter({ kind: kind as ChangedFile['kind'] }))).toEqual([
      'A',
      'A',
      'D',
      'R',
      'M',
    ]);
  });
});
