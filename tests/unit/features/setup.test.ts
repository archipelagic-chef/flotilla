import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copySetupFiles } from '../../../src/features/worktrees/setup';
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
