import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY, INDEX, readFileAtRef, sideRefsFor, WORKING } from '../../../src/core/diff/refs';
import { git, initRepo, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('sideRefsFor', () => {
  it('maps each change kind to left/right sides', () => {
    expect(sideRefsFor({ path: 'a', kind: 'modified' }, 'HEAD', WORKING)).toEqual({ left: { ref: 'HEAD', path: 'a' }, right: { ref: WORKING, path: 'a' } });
    expect(sideRefsFor({ path: 'a', kind: 'added' }, 'HEAD', WORKING).left).toEqual({ ref: EMPTY, path: 'a' });
    expect(sideRefsFor({ path: 'a', kind: 'untracked' }, 'HEAD', WORKING).left).toEqual({ ref: EMPTY, path: 'a' });
    expect(sideRefsFor({ path: 'a', kind: 'deleted' }, 'HEAD', WORKING).right).toEqual({ ref: EMPTY, path: 'a' });
    expect(sideRefsFor({ path: 'new', origPath: 'old', kind: 'renamed' }, 'base', 'HEAD')).toEqual({
      left: { ref: 'base', path: 'old' },
      right: { ref: 'HEAD', path: 'new' },
    });
  });
});

describe('readFileAtRef', () => {
  it('returns file content at a ref, and empty text for EMPTY or missing files', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    expect(await readFileAtRef(repo, 'HEAD', 'README.md')).toBe('hello\n');
    expect(await readFileAtRef(repo, EMPTY, 'README.md')).toBe('');
    expect(await readFileAtRef(repo, 'HEAD', 'missing.txt')).toBe('');
  });

  it('reads the staged version for INDEX', async () => {
    const repo = initRepo();
    cleanup.push(repo);
    writeFile(repo, 'README.md', 'staged\n');
    git(repo, 'add', 'README.md');
    writeFile(repo, 'README.md', 'working\n');
    expect(await readFileAtRef(repo, INDEX, 'README.md')).toBe('staged\n');
  });
});
