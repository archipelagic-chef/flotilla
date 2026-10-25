import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { WORKING } from '../../../src/core/diff/refs';
import { combine, parseNumstat, ticketChange } from '../../../src/features/diffs/ticketChange';
import {
  git,
  initRepo,
  makeStatDirty,
  removeDir,
  restatInPast,
  writeFile,
} from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

function repo(): string {
  const r = initRepo();
  cleanup.push(r);
  writeFile(r, 'src/a.ts', 'a\n'.repeat(10));
  git(r, 'add', '.');
  git(r, 'commit', '-q', '-m', 'base');
  return r;
}

function commit(dir: string, message: string, files: Record<string, string>): string {
  for (const [p, content] of Object.entries(files)) writeFile(dir, p, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

const brief = (files: Array<{ path: string; kind: string; added: number; deleted: number; uncommitted?: true }>) =>
  files.map((f) => `${f.kind} ${f.path} +${f.added} -${f.deleted}${f.uncommitted ? ' uncommitted' : ''}`);

describe('ticketChange', () => {
  it('in progress: the branch against its merge base, with the worktree’s uncommitted changes marked', async () => {
    const r = repo();
    const wt = path.join(r, '.worktrees', 'feat');
    git(r, 'worktree', 'add', '-q', '-b', 'feature/BL-1-x', wt);
    commit(wt, 'BL-1: Work', { 'src/a.ts': 'a\n'.repeat(9) + 'b\n', 'src/new.ts': 'n\nn\n' });
    commit(r, 'Main moves', { 'main.txt': 'm\n' });
    writeFile(wt, 'src/new.ts', 'n\nn\nn\n');
    writeFile(wt, 'notes.md', 'one\ntwo');

    const change = await ticketChange(r, { id: 'BL-1', base: 'main', branches: [{ branch: 'feature/BL-1-x', worktree: wt }] });

    expect(change.stage).toBe('work');
    expect(change.groups).toHaveLength(1);
    const [g] = change.groups;
    expect(g).toMatchObject({ branch: 'feature/BL-1-x', dir: wt, right: WORKING, uncommitted: 2 });
    expect(brief(g.files)).toEqual(['untracked notes.md +2 -0 uncommitted', 'modified src/a.ts +1 -1', 'added src/new.ts +3 -0 uncommitted']);
    expect(change).toMatchObject({ files: 3, added: 6, deleted: 1 });
  });

  it('reads the working tree without writing the worktree’s index', async () => {
    const r = repo();
    const tracked = ['one.txt', 'two.txt'];
    makeStatDirty(r, tracked);
    const wt = path.join(r, '.worktrees', 'feat');
    git(r, 'worktree', 'add', '-q', '-b', 'BL-1', wt);
    writeFile(wt, 'README.md', 'edited\n');
    restatInPast(wt, tracked);
    const index = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'index').trim());
    const before = fs.readFileSync(index);
    const mtime = fs.statSync(index).mtimeMs;

    const change = await ticketChange(r, { id: 'BL-1', base: 'main', branches: [{ branch: 'BL-1', worktree: wt }] });

    expect(brief(change.groups[0].files)).toEqual(['modified README.md +1 -1 uncommitted']);
    expect(fs.statSync(index).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(index).equals(before)).toBe(true);
  });

  it('two branches: a group each, with its own counts', async () => {
    const r = repo();
    git(r, 'branch', 'BL-2-api');
    git(r, 'branch', 'BL-2-ui');
    git(r, 'checkout', '-q', 'BL-2-api');
    commit(r, 'BL-2: Api', { 'api.ts': 'x\n' });
    git(r, 'checkout', '-q', 'BL-2-ui');
    commit(r, 'BL-2: Ui', { 'ui.ts': 'y\ny\n' });
    git(r, 'checkout', '-q', 'main');

    const change = await ticketChange(r, { id: 'BL-2', base: 'main', branches: [{ branch: 'BL-2-api' }, { branch: 'BL-2-ui' }] });

    expect(change.groups.map((g) => [g.label, g.files.length, g.added])).toEqual([
      ['BL-2-api', 1, 1],
      ['BL-2-ui', 1, 2],
    ]);
    expect(change.added).toBe(3);
  });

  it('merged: the merge commit (and the fixes on top) against its first parent, its branch deleted', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'BL-3');
    commit(r, 'BL-3: Work', { 'src/a.ts': 'z\n'.repeat(10), 'b.ts': 'b\n' });
    git(r, 'checkout', '-q', 'main');
    commit(r, 'Other work', { 'other.ts': 'o\n' });
    git(r, 'merge', '-q', '--no-ff', '-m', 'Merge BL-3: The title', 'BL-3');
    const fix = commit(r, 'BL-3: Fix the checks', { 'b.ts': 'b\nfixed\n' });
    git(r, 'branch', '-D', 'BL-3');
    commit(r, 'Later work', { 'later.ts': 'l\n' });

    const change = await ticketChange(r, { id: 'BL-3', base: 'main', branches: [], merged: { commit: fix, into: 'main' } });

    expect(change.stage).toBe('merged');
    expect(change.groups[0].right).toBe(fix);
    expect(change.groups[0].compared).toContain('fix on top');
    expect(brief(change.groups[0].files)).toEqual(['added b.ts +2 -0', 'modified src/a.ts +10 -10']);
  });

  it('merged without a merge commit (fast-forward): its own commits combined, not those that only mention it', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'other');
    commit(r, 'Merge-free work', { 'x.ts': 'x\n' });
    git(r, 'checkout', '-q', 'main');
    git(r, 'merge', '-q', '--no-ff', '-m', 'Merge BL-9: Another ticket', 'other');
    git(r, 'checkout', '-q', '-b', 'BL-4');
    commit(r, 'BL-4: Add', { 'c.ts': 'c\n', 'gone.ts': 'g\n' });
    git(r, 'mv', 'c.ts', 'd.ts');
    git(r, 'rm', '-q', 'gone.ts');
    git(r, 'commit', '-q', '-m', 'BL-4: Rename and drop');
    commit(r, 'BL-4: Edit', { 'src/a.ts': 'a\n'.repeat(11) });
    git(r, 'checkout', '-q', 'main');
    git(r, 'merge', '-q', '--ff-only', 'BL-4');
    const tip = git(r, 'rev-parse', 'HEAD').trim();
    git(r, 'branch', '-D', 'BL-4');
    commit(r, 'Unrelated, mentions BL-4 in passing', { 'mention.ts': 'm\n' });

    const change = await ticketChange(r, { id: 'BL-4', base: 'main', branches: [], merged: { commit: tip, into: 'main' } });

    expect(change.stage).toBe('commits');
    expect(change.groups[0].label).toBe('3 commits of BL-4');
    expect(brief(change.groups[0].files)).toEqual(['added d.ts +1 -0', 'modified src/a.ts +1 -0']);
  });

  it('no work: none', async () => {
    const r = repo();
    git(r, 'branch', 'BL-5');
    expect(await ticketChange(r, { id: 'BL-5', base: 'main', branches: [{ branch: 'BL-5' }] })).toEqual({
      stage: 'none',
      groups: [],
      files: 0,
      added: 0,
      deleted: 0,
    });
  });
});

describe('combine', () => {
  it('follows renames, and drops a file added and then deleted', () => {
    const files = combine([
      {
        hash: 'c1',
        parent: 'p',
        changes: [
          { path: 'a', kind: 'added' },
          { path: 'm', kind: 'modified' },
          { path: 'old', kind: 'modified' },
        ],
      },
      {
        hash: 'c2',
        parent: 'c1',
        changes: [
          { path: 'a', kind: 'deleted' },
          { path: 'new', origPath: 'old', kind: 'renamed' },
        ],
      },
      { hash: 'c3', parent: 'x', changes: [{ path: 'm', kind: 'modified' }] },
    ]);
    expect(files).toEqual([
      { path: 'm', kind: 'modified', left: 'p', right: 'c3' },
      { path: 'new', origPath: 'old', kind: 'renamed', left: 'p', right: 'c2' },
    ]);
  });
});

describe('parseNumstat', () => {
  it('reads counts, renames and binary files', () => {
    const out = ['3\t1\ta.ts', '2\t0\t', 'old.ts', 'new.ts', '-\t-\timg.png', ''].join('\0');
    expect([...parseNumstat(out)]).toEqual([
      ['a.ts', { added: 3, deleted: 1 }],
      ['new.ts', { added: 2, deleted: 0 }],
      ['img.png', { added: 0, deleted: 0, binary: true }],
    ]);
  });
});
