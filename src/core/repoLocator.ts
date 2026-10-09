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
  const commonDir = path.resolve(folder, common);
  if (path.basename(commonDir) !== '.git') return undefined;
  return {
    mainRoot: path.dirname(commonDir),
    commonDir,
    worktreeRoot: path.resolve(top),
    gitDir: path.resolve(folder, gitDir),
  };
}
