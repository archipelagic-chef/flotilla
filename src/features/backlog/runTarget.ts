/**
 * Where an `open` run block points (BL-24): a web link (http, https), or a file inside the worktree. Pure: the caller
 * checks that the file exists, and passes `real` (a path's real location, following symlinks) so that a link inside the
 * worktree that points outside it is refused too.
 */
import * as path from 'node:path';

export type OpenTarget = { url: string } | { file: string } | { refused: string };

export function openTarget(target: string, dir: string, real: (p: string) => string = (p) => p): OpenTarget {
  if (/^https?:\/\//i.test(target)) return { url: target };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { refused: `only web links (http, https) and files of the worktree can be opened, not ${target}` };
  if (!target.trim()) return { refused: 'it says nothing to open' };
  const file = path.resolve(dir, target);
  if (file === path.resolve(dir)) return { refused: 'it names the worktree itself, not a file' };
  if (!isInside(dir, file)) return { refused: `${target} is outside the worktree` };
  if (!isInside(real(dir), real(file))) return { refused: `${target} leads outside the worktree` };
  return { file };
}

/** Whether `p` is inside `root` (not `root` itself). Lexical: no file is looked at. */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
