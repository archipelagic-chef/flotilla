import { runGit } from '../git/gitCli';
import type { FileChange } from '../git/porcelain';

/** Right side is the file on disk. */
export const WORKING = 'WORKING';
/** Side has no content (added or deleted file). */
export const EMPTY = 'EMPTY';
/** Side is the staged version of the file. */
export const INDEX = 'INDEX';

export interface DiffSide {
  ref: string;
  path: string;
}

export function sideRefsFor(change: FileChange, leftRef: string, rightRef: string): { left: DiffSide; right: DiffSide } {
  const left: DiffSide =
    change.kind === 'added' || change.kind === 'untracked' ? { ref: EMPTY, path: change.path } : { ref: leftRef, path: change.origPath ?? change.path };
  const right: DiffSide = change.kind === 'deleted' ? { ref: EMPTY, path: change.path } : { ref: rightRef, path: change.path };
  return { left, right };
}

export async function readFileAtRef(worktreeDir: string, ref: string, relPath: string): Promise<string> {
  if (ref === EMPTY) return '';
  try {
    return await runGit(['show', `${ref === INDEX ? '' : ref}:${relPath}`], { cwd: worktreeDir });
  } catch {
    return '';
  }
}
