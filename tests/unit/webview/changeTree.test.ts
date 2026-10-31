import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  changeLink,
  changeRows,
  filterChange,
  filterFiles,
  fullRows,
  rowWindow,
  sinceLastReview,
  withDiffs,
} from '../../../src/webview/ticket/changeTree';
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
const show = (rows: ReturnType<typeof changeRows>) =>
  rows.map(
    (r) => `${'  '.repeat(r.kind === 'group' ? 0 : r.depth)}${r.kind === 'group' ? `[${r.group}]` : r.kind === 'folder' ? `${r.name}/ +${r.added}` : r.name}`,
  );

describe('changeRows', () => {
  it('folders first, chains of single folders as one, with their counts', () => {
    const rows = changeRows(change(group('b', [file('src/core/git/a.ts', 2), file('src/core/git/b.ts'), file('README.md', 3)])), new Set());
    expect(show(rows)).toEqual(['src/core/git/ +3', '  a.ts', '  b.ts', 'README.md']);
  });

  it('a folded folder hides its files; several groups get headers, and fold too', () => {
    const c = change(group('one', [file('x/a.ts'), file('x/b.ts'), file('top.ts')]), group('two', [file('c.ts')]));
    expect(show(changeRows(c, new Set(['0:x/'])))).toEqual(['[0]', '  x/ +2', '  top.ts', '[1]', '  c.ts']);
    expect(show(changeRows(c, new Set(['1:'])))).toEqual(['[0]', '  x/ +2', '    a.ts', '    b.ts', '  top.ts', '[1]']);
  });
});

describe('rowWindow', () => {
  it('renders only the rows in view, and some either side', () => {
    expect(rowWindow(5000, 22 * 1000, 440, 22)).toEqual({ start: 990, end: 1030 });
    expect(rowWindow(5, 0, 110, 22)).toEqual({ start: 0, end: 5 });
  });
});

describe('withDiffs', () => {
  it('puts an unfolded file’s hunks and lines under it, and says so while it’s read or when it isn’t shown', () => {
    const rows = changeRows(change(group('b', [file('a.ts'), file('b.ts'), file('c.png')])), new Set());
    const diffs = new Map([
      [
        '0:a.ts',
        {
          hunks: [
            {
              oldStart: 3,
              newStart: 3,
              lines: [
                { kind: 'context' as const, text: 'x', old: 3, new: 3 },
                { kind: 'deleted' as const, text: 'y', old: 4 },
                { kind: 'added' as const, text: 'z', new: 4 },
              ],
            },
          ],
        },
      ],
      ['0:c.png', { note: 'A binary file' }],
    ]);
    const out = withDiffs(rows, new Set(['0:a.ts', '0:b.ts', '0:c.png']), diffs).map((r) =>
      r.kind === 'hunk'
        ? `${r.label} @${r.line}`
        : r.kind === 'line'
          ? `${r.line.kind} ${r.line.text}`
          : r.kind === 'note'
            ? `(${r.text})`
            : r.kind === 'file'
              ? r.name
              : r.kind,
    );
    expect(out).toEqual(['a.ts', '@@ −3,2 +3,2 @@ @3', 'context x', 'deleted y', 'added z', 'b.ts', '(Reading its diff…)', 'c.png', '(A binary file)']);
    expect(withDiffs(rows, new Set(), diffs)).toHaveLength(3);
  });
});

describe('fullRows', () => {
  const ctx = (i: number) => ({ kind: 'context' as const, text: `c${i}` });
  const show = (rows: ReturnType<typeof fullRows>) => rows.map((r) => (r.kind === 'gap' ? `(${r.count} at ${r.index})` : r.line.text));
  it('folds unchanged stretches past the context around changes, and shows one asked for, or one too short to fold', () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => ctx(i)), { kind: 'added' as const, text: '+' }, ...Array.from({ length: 6 }, (_, i) => ctx(11 + i))];
    expect(show(fullRows(lines, new Set(), 2))).toEqual(['(8 at 0)', 'c8', 'c9', '+', 'c11', 'c12', '(4 at 13)']);
    expect(show(fullRows(lines, new Set([0, 13]), 2))).toHaveLength(17);
    expect(show(fullRows([{ kind: 'added', text: 'a' }], new Set()))).toEqual(['a']);
  });
});

describe('filterChange', () => {
  const c = change(group('api', [file('src/core/a.ts', 2), file('src/core/a.test.ts', 1)]), group('ui', [file('src/ui/b.tsx', 4), file('README.md', 3)]));

  it('narrows the files and their counts to the paths with every word; the groups keep their places', () => {
    const f = filterChange(c, 'src  .ts');
    expect(f.groups.map((g) => g.files.map((x) => x.path))).toEqual([['src/core/a.ts', 'src/core/a.test.ts'], ['src/ui/b.tsx']]);
    expect(f).toMatchObject({ files: 3, added: 7 });
    expect(filterChange(c, 'readme').groups.map((g) => g.files.length)).toEqual([0, 1]);
    // A branch left with nothing has no header; one left, none.
    expect(show(changeRows(filterChange(c, 'readme'), new Set()))).toEqual(['README.md']);
  });

  it('globs: * within a folder, ** across them', () => {
    expect(filterFiles(c.groups[0].files, '*.test.ts').map((f) => f.path)).toEqual(['src/core/a.test.ts']);
    expect(filterFiles([file('src/a/b/c.ts'), file('lib/c.ts')], 'src/**/c.ts').map((f) => f.path)).toEqual(['src/a/b/c.ts']);
    expect(filterFiles([file('src/a/b/c.ts')], 'src/*/c.ts')).toEqual([]);
    expect(filterChange(c, '  ')).toBe(c);
  });
});

describe('sinceLastReview', () => {
  const commits = [
    { hash: 'c3', date: new Date(2026, 9, 25, 12, 30).toISOString() },
    { hash: 'c2', date: new Date(2026, 9, 25, 10, 0, 30).toISOString() },
    { hash: 'c1', date: new Date(2026, 9, 24, 9, 0).toISOString() },
  ];

  it('the commits after your last entry (its minute counting as before it)', () => {
    const activity = [
      { author: 'You', date: '2026-10-24 18:00' },
      { author: 'Agent Mica-6', date: '2026-10-25 11:00' },
      { author: 'You', date: '2026-10-25 10:00' },
    ];
    expect(sinceLastReview(commits, activity)).toEqual(['c3']);
  });

  it('none written yet: none', () => {
    expect(sinceLastReview(commits, [{ author: 'Agent Orbit-2', date: '2026-10-23 20:25' }])).toEqual([]);
  });
});

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
