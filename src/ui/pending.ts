import { samePath } from '../core/paths';

/** Actions queued for the window that opens next. Older entries are dropped, never executed. */
export const PENDING_TTL_MS = 120_000;

export interface PendingRemoval {
  mainRoot: string;
  adminDir: string;
  force: boolean;
  deleteBranch: boolean;
  branch: string | undefined;
  createdAt: number;
}

export interface PendingSetup {
  worktreeDir: string;
  command: string;
  createdAt: number;
}

export function isFresh(entry: { createdAt?: unknown }, now: number): boolean {
  const created = entry.createdAt;
  return typeof created === 'number' && created <= now && now - created <= PENDING_TTL_MS;
}

/** Splits the setup queue into fresh entries for this window (run) and fresh entries for others (keep); stale ones are dropped. */
export function setupsToRun(queue: PendingSetup[], currentRoot: string, now: number): { run: PendingSetup[]; keep: PendingSetup[] } {
  const fresh = queue.filter((p) => isFresh(p, now));
  return {
    run: fresh.filter((p) => samePath(p.worktreeDir, currentRoot)),
    keep: fresh.filter((p) => !samePath(p.worktreeDir, currentRoot)),
  };
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

export function withoutSetup(queue: PendingSetup[], entry: PendingSetup): PendingSetup[] {
  return queue.filter((p) => !(samePath(p.worktreeDir, entry.worktreeDir) && p.command === entry.command && p.createdAt === entry.createdAt));
}
