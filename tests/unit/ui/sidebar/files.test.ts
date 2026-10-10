import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excludeMatcher, listDirectory } from '../../../../src/ui/sidebar/files';
import { initials } from '../../../../src/ui/sidebar/viewModel';
import { makeTempDir, removeDir, writeFile } from '../../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('initials', () => {
  it.each([
    ['feature/login-form', 'lf'],
    ['fix/typo', 'ty'],
    ['refactor/api_client', 'ac'],
    ['main', 'ma'],
    ['x', 'x'],
    ['detached @ abc1234', 'da'],
  ])('%s -> %s', (branch, expected) => expect(initials(branch)).toBe(expected));
});

describe('listDirectory', () => {
  it('sorts folders first with natural order, hides .git, .worktrees in the main worktree and excluded paths', async () => {
    const root = makeTempDir();
    cleanup.push(root);
    for (const f of ['b.txt', 'a10.txt', 'a2.txt', 'src/x.ts', 'node_modules/m/index.js', '.worktrees/w/f', 'Docs/readme.md']) writeFile(root, f, 'x');
    fs.mkdirSync(path.join(root, '.git'));
    const isExcluded = excludeMatcher({ '**/node_modules': true, '**/*.log': false, '**/.DS_Store': { when: 'x' } });
    const top = await listDirectory(root, '', { hideWorktrees: true, isExcluded });
    expect(top).toEqual([
      { name: 'Docs', dir: true },
      { name: 'src', dir: true },
      { name: 'a2.txt', dir: false },
      { name: 'a10.txt', dir: false },
      { name: 'b.txt', dir: false },
    ]);
    expect((await listDirectory(root, '', { hideWorktrees: false, isExcluded })).map((e) => e.name)).toContain('.worktrees');
    expect(await listDirectory(root, 'src', { hideWorktrees: true, isExcluded })).toEqual([{ name: 'x.ts', dir: false }]);
  });
});
