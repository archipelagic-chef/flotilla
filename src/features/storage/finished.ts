import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BacklogStatus } from '../backlog/backlog';

/** `auto`: a finished ticket's worktree is removed when that's safe; `ask`: every removal is a question; `off`: never. */
export type RemoveFinishedMode = 'auto' | 'ask' | 'off';

/** How often worktrees of finished tickets are looked for, besides when a ticket moves to Done. */
export const FINISHED_SWEEP_MS = 30 * 60_000;

/** Measuring what a removal frees stops after this; the removal doesn't wait longer for a number. */
export const MEASURE_LIMIT_MS = 5000;

export interface RemovalInput {
  status: BacklogStatus;
  proposed: boolean;
  isMain: boolean;
  /** The worktree's folder exists in this environment. */
  reachable: boolean;
  /** Another ticket that isn't done works on the same branch. */
  openTicketOnBranch: boolean;
  /** The user chose Keep for this ticket before. */
  kept: boolean;
  /** Uncommitted and untracked entries. */
  changedFiles: number;
  /** An agent is working or waiting for an answer in it (and its status isn't stale). */
  agentRunning: boolean;
  /** A window has it open, or it's this window's own folder. */
  windowOpen: boolean;
  /** Its files changed in the last few minutes. */
  recentlyActive: boolean;
}

export type RemovalDecision = { action: 'remove' } | { action: 'ask'; reason: string } | { action: 'skip' };

/**
 * Whether a done ticket's worktree goes: removed when nothing in it can be lost and nobody is using it, a question when
 * something is (with the reason), left alone otherwise. The branch is never part of it: removal always keeps it.
 */
export function removalDecision(i: RemovalInput): RemovalDecision {
  if (i.status !== 'done' || i.proposed || i.isMain || !i.reachable || i.openTicketOnBranch || i.kept) return { action: 'skip' };
  if (i.changedFiles > 0) return { action: 'ask', reason: `it has ${i.changedFiles} uncommitted or untracked file${i.changedFiles === 1 ? '' : 's'}` };
  if (i.agentRunning) return { action: 'ask', reason: 'an agent is still running in it' };
  if (i.windowOpen) return { action: 'ask', reason: "it's open in a window" };
  if (i.recentlyActive) return { action: 'ask', reason: 'its files changed in the last few minutes' };
  return { action: 'remove' };
}

/**
 * The bytes a removal of `dir` frees: files that have no other hard link (a folder shared with another worktree through
 * `flotilla.linkFolders` frees nothing). Links aren't followed. Undefined when it takes longer than `limitMs`.
 */
export async function freedBytes(dir: string, limitMs: number = MEASURE_LIMIT_MS): Promise<number | undefined> {
  const deadline = Date.now() + limitMs;
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    if (Date.now() > deadline) return undefined;
    const current = pending.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        pending.push(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.lstat(full);
          if (st.nlink <= 1) total += st.size;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return total;
}

/**
 * Deletes the symbolic links and junctions directly inside `dir`, as links: what they point to stays. `git worktree
 * remove` would otherwise be handed a worktree with a link to a folder outside it (one had a junction to the main
 * worktree's node_modules). Links named in `keep` (those git tracks) stay. Returns the names removed.
 */
export async function removeTopLevelLinks(dir: string, keep: ReadonlySet<string> = new Set()): Promise<string[]> {
  const removed: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isSymbolicLink() || keep.has(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      await fs.unlink(full);
    } catch (error) {
      // A directory link or junction on Windows: rmdir removes the link, never what it points to.
      if (!['EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await fs.rmdir(full);
    }
    removed.push(e.name);
  }
  return removed;
}

/** "248 MB", "3.1 GB", "12 KB". */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} bytes`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
