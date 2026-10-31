import type { CreatingRecord } from './creatingWorktrees';
import {
  ago,
  type Claim,
} from './ticketCheck';

/**
 * The worktree parts of a ticket's Check (BL-167): the worktrees a ticket names (its review's, its branches') and its
 * "Creating its worktree…" record, each checked against what's really there. Nothing here changes anything: a glitch
 * names its cleanup, which TicketChecker's Clean Up does.
 */

/** A worktree as the repository lists it (a Workstream's worktree is one). */
export interface WorktreeFacts {
  /** Its git dir: what a review's `worktree` names. */
  adminDir: string;
  /** Where it is here; undefined when it can't be reached from this environment. */
  path?: string;
  branch?: string;
}

/** How long a worktree may be "being created" before it's a glitch, even with its window running. */
export const CREATING_MAX_MS = 15 * 60_000;

const shortBranch = (b: string | undefined) => b?.replace(/^refs\/heads\//, '');

/** The worktree the review names (its `worktree`): there, and on one of the ticket's branches. */
export function checkReviewWorktree(
  named: string | undefined,
  worktrees: readonly WorktreeFacts[],
  onTicketsBranch: (branch: string) => boolean,
): Claim | undefined {
  if (!named) return undefined;
  const wt = worktrees.find((w) => w.adminDir === named);
  const cleanup = { kind: 'review-worktree', worktree: named } as const;
  const fix = "clears the review's worktree (it then works in the ticket's branch's)";
  const where = wt?.path ?? named;
  if (!wt) {
    return {
      key: 'worktree:review',
      ok: false,
      text: `Its review names worktree ${named}, but there's no such worktree`,
      cleanup,
      fix,
      note: `Check: the review named worktree ${named}, which was gone; cleared it.`,
    };
  }
  const on = shortBranch(wt.branch);
  if (!on || !onTicketsBranch(on)) {
    const now = on ? `on ${on}` : 'on no branch (detached)';
    return {
      key: 'worktree:review',
      ok: false,
      text: `Its review's worktree ${where} is ${now}, not on the ticket's branch`,
      cleanup,
      fix,
      note: `Check: the review's worktree ${where} was ${now}, not on the ticket's branch; cleared it.`,
    };
  }
  return { key: 'worktree:review', ok: true, text: `Its review's worktree ${where} is there, on ${on}` };
}

/**
 * The worktrees of the ticket's branches that are gone from disk though git still lists them (deleted outside git).
 * Those that are there claim nothing: a ticket with a worktree and nothing going on has nothing to check.
 */
export function checkBranchWorktrees(worktrees: readonly WorktreeFacts[], exists: (path: string) => boolean): Claim[] {
  return worktrees
    .filter((w): w is WorktreeFacts & { path: string } => !!w.path && !exists(w.path))
    .map((w) => ({
      key: `worktree:${w.adminDir}`,
      ok: false,
      text: `Worktree ${w.path} of ${shortBranch(w.branch)} is gone from disk, though git still lists it (remove it in the Worktrees view)`,
    }));
}

/**
 * A "Creating its worktree…" record: it holds while the window that creates it runs (on this machine; another's can't
 * be seen, so its record holds until it's too old) and it's not older than any creation takes.
 */
export function checkCreating(record: CreatingRecord, o: { dir: string; host: string; now: number; alive: (pid: number) => boolean }): Claim {
  const key = `creating:${record.id}`;
  const age = Math.max(0, o.now - record.at);
  const cleanup = { kind: 'creating-stale', dir: o.dir, id: record.id } as const;
  const fix = 'clears "Creating its worktree…"';
  if (record.host === o.host && !o.alive(record.pid)) {
    return {
      key,
      ok: false,
      text: `Its worktree shows as being created, but the window creating it (process ${record.pid}) is gone`,
      cleanup,
      fix,
      note: `Check: its worktree showed as being created, but the window creating it (process ${record.pid}) was gone; cleared it.`,
    };
  }
  if (age > CREATING_MAX_MS) {
    return {
      key,
      ok: false,
      text: `Its worktree has shown as being created for ${ago(age)}, longer than any creation takes`,
      cleanup,
      fix,
      note: `Check: its worktree had shown as being created for ${ago(age)}; cleared it.`,
    };
  }
  const where = record.host === o.host ? `process ${record.pid}` : `on ${record.host}`;
  return { key, ok: true, text: `Its worktree is being created (${where}, for ${ago(age)})` };
}
