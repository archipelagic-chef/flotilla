import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { git, initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

vi.mock('vscode', () => ({}));
const { worktreeFiles } = await import('../../../src/ui/quickOpen');

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('worktreeFiles', () => {
  it('lists tracked and untracked files, not ignored ones or other worktrees', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, '.gitignore', 'dist/\n');
    writeFile(repo, 'src/a.ts', 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'a');
    writeFile(repo, 'new.txt', 'n');
    writeFile(repo, 'dist/out.js', 'x');
    writeFile(repo, '.git/info/exclude', '/.worktrees/\n');
    git(repo, 'worktree', 'add', '-q', '-b', 'w', path.join(repo, '.worktrees', 'w'));
    expect((await worktreeFiles(repo)).sort()).toEqual(['.gitignore', 'README.md', 'new.txt', 'src/a.ts']);
  });
});
