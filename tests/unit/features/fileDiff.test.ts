import { afterEach, describe, expect, it } from 'vitest';
import { WORKING } from '../../../src/core/diff/refs';
import { fileDiff, parseHunks } from '../../../src/features/diffs/fileDiff';
import { git, initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const lines = (d: Awaited<ReturnType<typeof fileDiff>>) =>
  'note' in d ? d.note : d.hunks.flatMap((h) => h.lines.map((l) => `${l.old ?? '.'} ${l.new ?? '.'} ${l.kind[0]} ${l.text}`));

describe('parseHunks', () => {
  it('numbers each line on its sides, across hunks, past "No newline"', () => {
    const out = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@ fn', ' one', '-two', '+TWO', '\\ No newline at end of file', '@@ -10 +10,2 @@', ' ten', '+eleven', ''].join('\n');
    const hunks = parseHunks(out);
    expect(hunks.map((h) => [h.oldStart, h.newStart, h.lines.length])).toEqual([
      [1, 1, 3],
      [10, 10, 2],
    ]);
    expect(hunks[0].lines[2]).toEqual({ kind: 'added', text: 'TWO', new: 2 });
    expect(hunks[1].lines[1]).toEqual({ kind: 'added', text: 'eleven', new: 11 });
  });
});

describe('fileDiff', () => {
  it('a file in the worktree against a commit, uncommitted edits included; an untracked file; a binary or big one says so', async () => {
    const r = initRepo();
    cleanup.push(r);
    writeFile(r, 'a.ts', 'one\ntwo\nthree\n');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'base');
    const base = git(r, 'rev-parse', 'HEAD').trim();
    writeFile(r, 'a.ts', 'one\nTWO\nthree\n');
    writeFile(r, 'new.md', 'hi\nthere\n');

    expect(lines(await fileDiff(r, { path: 'a.ts', kind: 'modified', added: 1, deleted: 1 }, base, WORKING))).toEqual(['1 1 c one', '2 . d two', '. 2 a TWO', '3 3 c three']);
    expect(lines(await fileDiff(r, { path: 'new.md', kind: 'untracked', added: 2, deleted: 0 }, base, WORKING))).toEqual(['. 1 a hi', '. 2 a there']);
    expect(lines(await fileDiff(r, { path: 'i.png', kind: 'added', added: 0, deleted: 0, binary: true }, base, WORKING))).toContain('binary');
    expect(lines(await fileDiff(r, { path: 'a.ts', kind: 'modified', added: 3000, deleted: 0 }, base, WORKING))).toContain('3,000 changed lines');
  });

  it('between two commits, a rename followed', async () => {
    const r = initRepo();
    cleanup.push(r);
    writeFile(r, 'old.ts', 'a\nb\nc\nd\n');
    git(r, 'add', '.');
    git(r, 'commit', '-q', '-m', 'base');
    const left = git(r, 'rev-parse', 'HEAD').trim();
    git(r, 'rm', '-q', 'old.ts');
    writeFile(r, 'src/new.ts', 'a\nb\nc\nD\n');
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'move');
    const right = git(r, 'rev-parse', 'HEAD').trim();

    const d = await fileDiff(r, { path: 'src/new.ts', origPath: 'old.ts', kind: 'renamed', added: 1, deleted: 1 }, left, right);
    expect(lines(d)).toEqual(['1 1 c a', '2 2 c b', '3 3 c c', '4 . d d', '. 4 a D']);
  });
});
