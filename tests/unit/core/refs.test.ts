import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY, INDEX, readFileAtRef, readFileBytesAtRef, sideRefsFor, WORKING } from '../../../src/core/diff/refs';
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

describe('readFileBytesAtRef', () => {
  it("returns a binary file's bytes unchanged", async () => {
    const repo = initRepo();
    cleanup.push(repo);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
    fs.writeFileSync(path.join(repo, 'image.png'), bytes);
    git(repo, 'add', 'image.png');
    git(repo, 'commit', '-q', '-m', 'image');
    expect(Buffer.from(await readFileBytesAtRef(repo, 'HEAD', 'image.png')).equals(bytes)).toBe(true);
    expect((await readFileBytesAtRef(repo, EMPTY, 'image.png')).byteLength).toBe(0);
    expect((await readFileBytesAtRef(repo, 'HEAD', 'missing.png')).byteLength).toBe(0);
  });
});
