import { samePath } from '../core/paths';

/** A removal queued for the window that opens next. Older entries are dropped, never executed. */
export const PENDING_TTL_MS = 120_000;

export interface PendingRemoval {
  mainRoot: string;
  adminDir: string;
  force: boolean;
  deleteBranch: boolean;
  branch: string | undefined;
  createdAt: number;
}

export function isFresh(entry: { createdAt?: unknown }, now: number): boolean {
  const created = entry.createdAt;
  return typeof created === 'number' && created <= now && now - created <= PENDING_TTL_MS;
}

/** A pending removal runs only in the main worktree window of its repo, and only while fresh. Stale ones are cleared. */
export function removalToRun(
  removal: PendingRemoval | undefined,
  mainRoot: string,
  currentRoot: string,
  now: number,
): { run: PendingRemoval | undefined; clear: boolean } {
  if (!removal) return { run: undefined, clear: false };
  if (!isFresh(removal, now)) return { run: undefined, clear: true };
  if (samePath(removal.mainRoot, mainRoot) && samePath(currentRoot, removal.mainRoot)) return { run: removal, clear: true };
  return { run: undefined, clear: false };
}


