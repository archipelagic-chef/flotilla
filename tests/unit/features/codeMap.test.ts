import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFiles, codeMap, findClash, mapNote, namedPaths, relatedTickets, titleWords } from '../../../src/features/backlog/codeMap';
import type { BacklogItem } from '../../../src/features/backlog/backlog';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const item = (id: string, title: string, more: Partial<BacklogItem> = {}): BacklogItem => ({ id, title, status: 'done', created: '', ...more }) as BacklogItem;

function commit(cwd: string, message: string, files: Record<string, string>): void {
  for (const [f, text] of Object.entries(files)) writeFile(cwd, f, text);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', message);
}

function repo(): string {
  const dir = makeTempDir();
  cleanup.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  commit(dir, 'init', { 'README.md': '# x' });
  commit(dir, 'BL-1: Review rounds', { 'src/review.ts': '1', 'package.json': '{}' });
  commit(dir, 'BL-1: More review', { 'src/review.ts': '2', 'src/loop.ts': '1' });
  commit(dir, 'BL-2: Token budget for agents', { 'src/budget.ts': '1' });
  commit(dir, 'BL-3: Sidebar colors', { 'src/colors.ts': '1' });
  return dir;
}

describe('a ticket\'s map of the code', () => {
  it('reads the paths a description names', () => {
    expect(namedPaths('See [src/a.ts:42](src/a.ts#L42), `src/b/c.tsx` and src/d.ts:12.\nNot a URL http://x.io/y or a word.')).toEqual(['src/a.ts', 'src/b/c.tsx', 'src/d.ts']);
  });

  it('relates its parts and what it depends on firmly; its parent and done tickets with a similar title loosely', () => {
    const items = [
      item('BL-1', 'Review rounds for agents'),
      item('BL-2', 'Token budget for agents'),
      item('BL-3', 'Sidebar colors'),
      item('BL-9', 'Agent token budget per ticket', { status: 'todo', parent: 'BL-5' }),
      item('BL-10', 'A part', { status: 'todo', parent: 'BL-9' }),
    ];
    expect(relatedTickets(items[3], 'Depends on: BL-3', items)).toEqual({ firm: ['BL-10', 'BL-3'], loose: ['BL-2', 'BL-5'] });
    expect([...titleWords('Agents get a token budget')]).toEqual(['agent', 'token', 'budget']);
  });

  it('puts the firm files first, without the files every ticket touches, and only those still there', async () => {
    const cwd = repo();
    const items = [item('BL-1', 'Review rounds'), item('BL-2', 'Token budget for agents'), item('BL-3', 'Sidebar colors')];
    const map = await codeMap(cwd, item('BL-9', 'Agents keep a token budget', { status: 'todo' }), 'Depends on: BL-1. Change `src/colors.ts`, not src/gone.ts.', items);
    expect(map).toEqual({ files: ['src/colors.ts', 'src/review.ts', 'src/loop.ts', 'src/budget.ts'], firm: ['src/colors.ts', 'src/review.ts', 'src/loop.ts'] });
    expect(mapNote(map)).toMatch(/^Places to start .*: src\/colors\.ts, src\/review\.ts, src\/loop\.ts, src\/budget\.ts\.$/);
    expect(mapNote({ files: [], firm: [] })).toBeUndefined();
  });
});

describe('clashes between tickets', () => {
  it('finds what a worktree changes: its commits since main, and what is not committed', async () => {
    const cwd = repo();
    git(cwd, 'checkout', '-qb', 'feature/x');
    commit(cwd, 'BL-4: x', { 'src/review.ts': '3', 'package.json': '{"a":1}' });
    writeFile(cwd, 'src/loop.ts', 'changed');
    expect((await changedFiles(cwd, 'main')).sort()).toEqual(['src/loop.ts', 'src/review.ts']);
  });

  it('holds a ticket whose firm files a ticket in progress changes, not itself', () => {
    const busy = new Map([
      ['BL-4', new Set(['src/a.ts'])],
      ['BL-5', new Set(['src/b.ts', 'src/c.ts'])],
    ]);
    expect(findClash(['src/c.ts', 'src/b.ts'], busy, 'BL-9')).toEqual({ with: 'BL-5', files: ['src/c.ts', 'src/b.ts'] });
    expect(findClash(['src/a.ts'], busy, 'BL-4')).toBeUndefined();
    expect(findClash(['src/z.ts'], busy, 'BL-9')).toBeUndefined();
  });
});
