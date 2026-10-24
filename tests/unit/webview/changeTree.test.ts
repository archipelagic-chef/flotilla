import { describe, expect, it } from 'vitest';
import { changeRows, rowWindow } from '../../../src/webview/ticket/changeTree';
import type { ChangeGroup, ChangedFile, TicketChange } from '../../../src/webview/ticketProtocol';

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
  rows.map((r) => `${'  '.repeat(r.kind === 'group' ? 0 : r.depth)}${r.kind === 'group' ? `[${r.group}]` : r.kind === 'folder' ? `${r.name}/ +${r.added}` : r.name}`);

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
