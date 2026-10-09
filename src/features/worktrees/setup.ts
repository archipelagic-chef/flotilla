import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { WORKTREES_DIR } from './layout';

export async function copySetupFiles(mainRoot: string, worktreeDir: string, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const files = await glob([...patterns], {
    cwd: mainRoot,
    dot: true,
    onlyFiles: true,
    ignore: ['.git/**', `${WORKTREES_DIR}/**`, '**/node_modules/**'],
  });
  const copied: string[] = [];
  for (const rel of [...new Set(files)].sort()) {
    const target = path.join(worktreeDir, rel);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(mainRoot, rel), target, constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return copied;
}
