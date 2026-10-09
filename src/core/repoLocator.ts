// fs/promises realpath has the semantics of fs.realpath.native.
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { runGit } from './git/gitCli';

export interface RepoLocation {
  /** Root of the main worktree (parent of the common .git dir). */
  mainRoot: string;
  /** The shared .git directory. */
  commonDir: string;
  /** Root of the worktree that contains the folder. */
  worktreeRoot: string;
  /** Git dir of that worktree (commonDir for the main worktree). */
  gitDir: string;
}

export async function locateRepo(folder: string): Promise<RepoLocation | undefined> {
  let out: string;
  try {
    out = await runGit(['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'], { cwd: folder });
  } catch {
    return undefined;
  }
  const [top, common, gitDir] = out.split(/\r?\n/);
  if (!top || !common || !gitDir) return undefined;
  const commonPath = path.resolve(folder, common);
  if (path.basename(commonPath) !== '.git') return undefined;
  // Real paths: git writes real paths into .git files and back-pointers, and resolves `..` physically,
  // so paths reached through a symlinked folder would break relative gitdirs and path comparisons.
  try {
    return {
      mainRoot: await realpath(path.dirname(commonPath)),
      commonDir: await realpath(commonPath),
      worktreeRoot: await realpath(path.resolve(folder, top)),
      gitDir: await realpath(path.resolve(folder, gitDir)),
    };
  } catch {
    return undefined;
  }
}
