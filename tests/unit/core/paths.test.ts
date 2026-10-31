import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isInside,
  samePath,
  toGitPath,
} from '../../../src/core/paths';
import { makeTempDir } from '../../helpers/gitRepo';

describe('paths', () => {
  const tmp = makeTempDir();

  it('samePath ignores redundant segments', () => {
    expect(samePath(path.join(tmp, 'a'), path.join(tmp, 'a', '..', 'a'))).toBe(true);
    expect(samePath(path.join(tmp, 'a'), path.join(tmp, 'b'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('samePath is case-insensitive on Windows', () => {
    expect(samePath('C:\\Repo\\x', 'c:\\repo\\X')).toBe(true);
  });

  it('isInside is strict', () => {
    expect(isInside(tmp, path.join(tmp, 'x', 'y'))).toBe(true);
    expect(isInside(tmp, tmp)).toBe(false);
    expect(isInside(path.join(tmp, 'x'), tmp)).toBe(false);
    expect(isInside(path.join(tmp, 'x'), path.join(tmp, 'xy'))).toBe(false);
  });

  it('toGitPath uses forward slashes', () => {
    expect(toGitPath('a\\b\\c')).toBe('a/b/c');
    expect(toGitPath('a/b')).toBe('a/b');
  });
});

describe('resolveInside', () => {
  it('accepts paths inside the root and rejects ones that leave it', async () => {
    const { resolveInside } = await import('../../../src/core/paths');
    const root = path.resolve('/r/wt');
    expect(resolveInside(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInside(root, '')).toBe(root);
    expect(resolveInside(root, 'src/../b.ts')).toBe(path.join(root, 'b.ts'));
    expect(() => resolveInside(root, '../other/x')).toThrow(/outside/);
    expect(() => resolveInside(root, '../wt2')).toThrow(/outside/);
    expect(() => resolveInside(root, path.resolve('/etc/passwd'))).toThrow(/outside/);
  });
});
