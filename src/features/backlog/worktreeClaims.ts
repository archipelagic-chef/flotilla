import { samePath } from '../../core/paths';
import type { CreatingRecord } from './creatingWorktrees';

/**
 * The worktree parts of a ticket's Check (BL-167): the worktrees a ticket names (its review's, its branches') and its
 * "Creating its worktree…" records, each checked against what's really there. Nothing here changes anything: a glitch
 * names its cleanup, which the Check's Clean Up does.
 */

/** A worktree as git lists it (a ResolvedWorktree is one). */
export interface WorktreeFacts {
  /** Where it is here; undefined when it can't be reached from this environment. */
  path: string | undefined;
  recordedPath: string;
  branch: string | undefined;
}

/** A worktree the ticket names, and the branch it should be on. */
export interface NamedWorktree {
  /** What names it, for the user: "its review", "branch feature/x". */
  source: 'review' | 'branch';
  path: string;
  branch?: string;
}

export type WorktreeCleanup =
  /** The review names a worktree that's gone or on another branch: its `worktree` is cleared. */
  | { kind: 'review-worktree'; path: string }
  /** A creation record whose window no longer runs: its file is removed. */
  | { kind: 'creating-stale'; id: string };

export interface WorktreeClaim {
  key: string;
  ok: boolean;
  text: string;
  cleanup?: WorktreeCleanup;
  /** What Clean Up does, for the user. */
  fix?: string;
}

/** How long a worktree may be "being created" before it's a glitch, even with its window running. */
export const CREATING_MAX_MS = 15 * 60_000;

const shortBranch = (b: string | undefined) => b?.replace(/^refs\/heads\//, '');

/** Each named worktree: it's there, and on its branch (when one is named). */
export function checkNamedWorktrees(named: readonly NamedWorktree[], worktrees: readonly WorktreeFacts[]): WorktreeClaim[] {
  return named.map((n) => {
    const key = `worktree:${n.source}:${n.path}`;
    const wt = worktrees.find((w) => (w.path && samePath(w.path, n.path)) || samePath(w.recordedPath, n.path));
    const what = n.source === 'review' ? 'Its review' : `Branch ${n.branch}`;
    const cleanup: WorktreeCleanup | undefined = n.source === 'review' ? { kind: 'review-worktree', path: n.path } : undefined;
    const fix = cleanup ? 'clears the review’s worktree' : undefined;
    if (!wt) return { key, ok: false, text: `${what} names worktree ${n.path}, but git has no worktree there`, cleanup, fix };
    const on = shortBranch(wt.branch);
    if (n.branch && on !== shortBranch(n.branch)) {
      return { key, ok: false, text: `Worktree ${n.path} should be on ${shortBranch(n.branch)}, but it's on ${on ?? 'no branch (detached)'}`, cleanup, fix };
    }
    return { key, ok: true, text: `Worktree ${n.path} is there${on ? `, on ${on}` : ''}` };
  });
}

/**
 * A "Creating its worktree…" record: it holds while the window that creates it runs (on this machine; another's can't
 * be seen, so its record holds until it's too old) and it's not older than any creation takes.
 */
export function checkCreating(
  record: CreatingRecord,
  o: { host: string; now: number; alive: (pid: number) => boolean },
): WorktreeClaim {
  const key = `creating:${record.id}`;
  const age = o.now - record.at;
  const cleanup: WorktreeCleanup = { kind: 'creating-stale', id: record.id };
  const fix = 'clears “Creating its worktree…”';
  const mins = Math.max(1, Math.round(age / 60_000));
  if (record.host === o.host && !o.alive(record.pid)) {
    return { key, ok: false, text: `Its worktree shows as being created, but the window creating it (process ${record.pid}) is gone`, cleanup, fix };
  }
  if (age > CREATING_MAX_MS) {
    return { key, ok: false, text: `Its worktree has shown as being created for ${mins} min, longer than any creation takes`, cleanup, fix };
  }
  const where = record.host === o.host ? `process ${record.pid}` : `on ${record.host}`;
  return { key, ok: true, text: `Its worktree is being created (${where}, for ${age < 60_000 ? `${Math.round(age / 1000)} s` : `${mins} min`})` };
}
