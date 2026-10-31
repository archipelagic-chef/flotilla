import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import { openTarget } from '../../../src/features/backlog/runTarget';

const dir = path.resolve('/work/tree');
const inside = (rel: string) => path.join(dir, rel);

describe('the open block', () => {
  it('opens web links', () => {
    expect(openTarget('http://localhost:5173', dir)).toEqual({ url: 'http://localhost:5173' });
    expect(openTarget('https://example.com/a?b=1', dir)).toEqual({ url: 'https://example.com/a?b=1' });
  });

  it('refuses other schemes, and nothing to open', () => {
    for (const target of ['javascript:alert(1)', 'vscode://file/etc', 'mailto:a@b.c', 'file:///etc/passwd', 'C:\\Windows']) {
      expect(openTarget(target, dir)).toHaveProperty('refused');
    }
    expect(openTarget('', dir)).toEqual({ refused: 'it says nothing to open' });
    expect(openTarget('   ', dir)).toHaveProperty('refused');
  });

  it('opens a file inside the worktree', () => {
    expect(openTarget('src/a.ts', dir)).toEqual({ file: inside('src/a.ts') });
    expect(openTarget('./README.md', dir)).toEqual({ file: inside('README.md') });
    expect(openTarget('src/../docs/x.md', dir)).toEqual({ file: inside('docs/x.md') });
  });

  it('refuses paths outside the worktree, and the worktree itself', () => {
    expect(openTarget('../other/secret.md', dir)).toEqual({ refused: '../other/secret.md is outside the worktree' });
    expect(openTarget('src/../../x', dir)).toHaveProperty('refused');
    expect(openTarget(path.resolve('/etc/passwd'), dir)).toHaveProperty('refused');
    expect(openTarget('..', dir)).toHaveProperty('refused');
    expect(openTarget('.', dir)).toEqual({ refused: 'it names the worktree itself, not a file' });
  });

  it('does not treat a name that starts with dots as leaving the worktree', () => {
    expect(openTarget('..notes.md', dir)).toEqual({ file: inside('..notes.md') });
  });

  it('refuses a link inside the worktree that points outside it', () => {
    // real() resolves symlinks: src/link is inside, but its real location is not.
    const real = (p: string) => (p === inside('src/link') ? path.resolve('/outside/secret') : p);
    expect(openTarget('src/link', dir, real)).toEqual({ refused: 'src/link leads outside the worktree' });
    expect(openTarget('src/a.ts', dir, real)).toEqual({ file: inside('src/a.ts') });
  });

  it('follows a worktree that is itself a link: its files are still inside it', () => {
    // The worktree's real place is /elsewhere; everything under it is inside.
    const real = (p: string) => (p.startsWith(dir) ? path.join(path.resolve('/elsewhere'), path.relative(dir, p)) : p);
    expect(openTarget('src/a.ts', dir, real)).toEqual({ file: inside('src/a.ts') });
  });
});
