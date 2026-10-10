import * as path from 'node:path';

/** Normalized key for comparing paths in the current environment. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when child is strictly inside parent. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Joins a relative path onto root and makes sure the result stays inside root (or is root). Paths come from the
 * webview, context menus and files on disk, so a "../" or absolute path must never reach outside the worktree.
 */
export function resolveInside(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (!samePath(full, root) && !isInside(root, full)) throw new Error(`${rel} is outside ${root}.`);
  return full;
}
