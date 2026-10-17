import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copySetupFiles, linkFolders, shareLinkedFolder } from '../../../src/features/worktrees/setup';
import { makeTempDir, removeDir, writeFile } from '../../helpers/gitRepo';

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(removeDir));

describe('copySetupFiles', () => {
  it('copies matching files, keeps relative paths and never overwrites', async () => {
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    writeFile(main, '.env', 'A=1\n');
    writeFile(main, '.env.local', 'B=2\n');
    writeFile(main, 'config/local.json', '{}\n');
    writeFile(main, '.worktrees/other/.env', 'nope\n');
    writeFile(main, '.git/config', 'nope\n');
    writeFile(wt, '.env.local', 'keep\n');

    const copied = await copySetupFiles(main, wt, ['.env', '.env.*', 'config/*.json', '**/.env']);
    expect(copied).toEqual(['.env', 'config/local.json']);
    expect(fs.readFileSync(path.join(wt, '.env.local'), 'utf8')).toBe('keep\n');
    expect(fs.readFileSync(path.join(wt, 'config', 'local.json'), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(path.join(wt, '.worktrees'))).toBe(false);
  });

  it('does nothing without patterns', async () => {
    expect(await copySetupFiles(makeTempDir(), makeTempDir(), [])).toEqual([]);
  });
});

describe('linkFolders', () => {
  const pair = () => {
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    return { main, wt };
  };

  it('hard-links every file of the folder, so they take no extra space', async () => {
    const { main, wt } = pair();
    writeFile(main, 'node_modules/a/index.js', 'a');
    writeFile(main, 'node_modules/a/lib/deep.js', 'deep');
    writeFile(main, 'node_modules/.package-lock.json', '{}');

    expect(await linkFolders(main, wt, ['node_modules'])).toEqual([{ folder: 'node_modules', files: 3 }]);

    const src = fs.statSync(path.join(main, 'node_modules/a/lib/deep.js'));
    const dest = fs.statSync(path.join(wt, 'node_modules/a/lib/deep.js'));
    expect(dest.ino).toBe(src.ino);
    expect(dest.nlink).toBe(2);
    expect(fs.readFileSync(path.join(wt, 'node_modules/.package-lock.json'), 'utf8')).toBe('{}');
  });

  it('makes links inside the folder again, pointing into the new copy', async () => {
    const { main, wt } = pair();
    writeFile(main, 'node_modules/real/index.js', 'x');
    fs.symlinkSync(path.join(main, 'node_modules/real'), path.join(main, 'node_modules/alias'), 'junction');

    await linkFolders(main, wt, ['node_modules']);

    const alias = path.join(wt, 'node_modules/alias');
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(alias)).toBe(fs.realpathSync(path.join(wt, 'node_modules/real')));
  });

  it('falls back when hard links fail, leaving nothing half made', async () => {
    const { main, wt } = pair();
    writeFile(main, 'node_modules/a/index.js', 'a');
    const exdev = async () => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    };

    expect(await linkFolders(main, wt, ['node_modules'], exdev)).toEqual([{ folder: 'node_modules', files: 0, skipped: 'it is on another drive' }]);
    expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
  });

  it('skips folders that are missing, already there, or outside the worktree', async () => {
    const { main, wt } = pair();
    writeFile(main, 'dist/x.js', 'x');
    writeFile(wt, 'dist/y.js', 'y');

    const results = await linkFolders(main, wt, ['node_modules', 'dist', '../elsewhere']);

    expect(results.map((r) => [r.folder, r.skipped])).toEqual([
      ['node_modules', 'the main worktree has no such folder'],
      ['dist', 'the new worktree has it already'],
      ['../elsewhere', 'it is outside the worktree'],
    ]);
    expect(fs.existsSync(path.join(wt, 'dist/x.js'))).toBe(false);
  });
});

describe('shareLinkedFolder', () => {
  it('turns identical files into links to the main worktree’s, and leaves different ones', async () => {
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    writeFile(main, 'node_modules/a/index.js', 'same');
    writeFile(wt, 'node_modules/a/index.js', 'same');
    writeFile(main, 'node_modules/b/index.js', 'version 1');
    writeFile(wt, 'node_modules/b/index.js', 'version 2');
    writeFile(wt, 'node_modules/only-here/index.js', 'mine');

    const result = await shareLinkedFolder(main, wt, 'node_modules');

    expect(result).toEqual({ folder: 'node_modules', files: 1, bytes: 4, skipped: 0 });
    expect(fs.statSync(path.join(wt, 'node_modules/a/index.js')).ino).toBe(fs.statSync(path.join(main, 'node_modules/a/index.js')).ino);
    expect(fs.readFileSync(path.join(wt, 'node_modules/b/index.js'), 'utf8')).toBe('version 2');
    expect(fs.readFileSync(path.join(wt, 'node_modules/only-here/index.js'), 'utf8')).toBe('mine');
    expect(fs.readdirSync(path.join(wt, 'node_modules/a'))).toEqual(['index.js']);
  });

  it('does nothing the second time', async () => {
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    writeFile(main, 'node_modules/a/index.js', 'same');
    writeFile(wt, 'node_modules/a/index.js', 'same');
    await shareLinkedFolder(main, wt, 'node_modules');
    expect(await shareLinkedFolder(main, wt, 'node_modules')).toEqual({ folder: 'node_modules', files: 0, bytes: 0, skipped: 0 });
  });

  it('leaves the folder alone when the worktree has none', async () => {
    const main = makeTempDir();
    const wt = makeTempDir();
    cleanup.push(main, wt);
    writeFile(main, 'node_modules/a/index.js', 'same');
    expect(await shareLinkedFolder(main, wt, 'node_modules')).toEqual({ folder: 'node_modules', files: 0, bytes: 0, skipped: 0 });
    expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
  });
});
