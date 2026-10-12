import * as path from 'node:path';

/** The folder worktrees are kept in, inside the main folder: VS Code should not watch, search or scan it. */
export const WORKTREES_FOLDER = '.worktrees';

/** files.watcherExclude pattern for it (relative to each window's folder). */
export const WATCHER_GLOB = `${WORKTREES_FOLDER}/**`;

/** The settings that exclude the worktrees folder, as VS Code reports them (defaults included). */
export interface ExclusionSettings {
  watcherExclude: Record<string, unknown>;
  searchExclude: Record<string, unknown>;
  scanIgnoredFolders: readonly string[];
}

/** Whether a worktree's folder is inside the main checkout's worktrees folder: the one place the exclusions hide. */
export function isInWorktreesFolder(mainRoot: string, worktreePath: string): boolean {
  const rel = path.relative(path.resolve(mainRoot, WORKTREES_FOLDER), path.resolve(worktreePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** What the worktrees folder is still visible to, by name; empty when every exclusion is in effect. */
export function missingExclusions(settings: ExclusionSettings): string[] {
  const missing: string[] = [];
  if (settings.watcherExclude[WATCHER_GLOB] !== true) missing.push('file watching');
  if (settings.searchExclude[WORKTREES_FOLDER] !== true) missing.push('search');
  if (!settings.scanIgnoredFolders.includes(WORKTREES_FOLDER)) missing.push('the Git repository scan');
  return missing;
}
