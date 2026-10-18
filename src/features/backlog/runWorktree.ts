/**
 * Where a ticket's run block runs (BL-20): in the worktree of one of the ticket's branches, and what to say when there
 * is none here. Also what the user approved, so that a block asks again only when it changed. Pure: the caller passes
 * the ticket's worktrees and reads the workspace.
 */
import * as crypto from 'node:crypto';
import type { RunBlock } from './runBlocks';

/** A worktree of the ticket: its branch, and its folder in this environment (undefined when it isn't reachable here). */
export interface TicketWorktree {
  branch?: string;
  path?: string;
  adminDir: string;
}

export interface RunPlace {
  /** The branch, or the admin dir's name for a worktree without one. */
  label: string;
  dir: string;
}

export interface RunPlaces {
  /** The worktrees a block can run in from this window. */
  reachable: RunPlace[];
  /** Branches whose worktree exists but has no folder in this environment (another machine, a container). */
  unreachable: string[];
  /** Branches of the ticket with no worktree at all (removed, or never made). */
  missing: string[];
}

/** Sorts the ticket's branches into the worktrees a run can use here, and the ones it can't. */
export function runPlaces(branches: readonly string[], worktrees: readonly TicketWorktree[]): RunPlaces {
  const reachable: RunPlace[] = [];
  const unreachable: string[] = [];
  for (const w of worktrees) {
    const label = w.branch ?? w.adminDir.split(/[\\/]/).pop() ?? w.adminDir;
    if (w.path) reachable.push({ label, dir: w.path });
    else unreachable.push(label);
  }
  const missing = branches.filter((b) => !worktrees.some((w) => w.branch === b));
  return { reachable, unreachable, missing };
}

/**
 * What the user approved: a fingerprint of the block and the worktree it runs in. A block that changed, or one run in
 * another worktree, asks again.
 */
export function runFingerprint(id: string, dir: string, block: RunBlock): string {
  return crypto.createHash('sha256').update(JSON.stringify([id, dir, block.kind, block.title ?? '', block.lines])).digest('hex');
}

/** What to say when a launch or task block names one that the worktree doesn't have. */
export function unknownNameMessage(kind: 'launch' | 'task', name: string | undefined, names: readonly string[], dir: string): string {
  if (!name) return `The ${kind} block has no name: write the ${kind === 'launch' ? 'configuration' : 'task'}'s name after \`${kind}\`.`;
  const what = kind === 'launch' ? 'launch configuration' : 'task';
  return `There's no ${what} named "${name}" in ${dir}.${names.length ? ` Its ${what}s are: ${names.join(', ')}.` : ` It has no ${what}s.`}`;
}

/**
 * What the ticket's terminal is like: none yet; idle; running something (shell integration says so); or a terminal
 * whose shell integration isn't there, so that nobody can tell whether something runs in it.
 */
export type TerminalState = 'none' | 'idle' | 'running' | 'unknown';

/**
 * What to do with it: make a new terminal, send the commands to the one there, or ask first (then "Stop and Run" stops
 * what runs and sends them; without it nothing runs). `known` says whether we could tell that something runs.
 */
export type TerminalPlan = { action: 'new' } | { action: 'reuse' } | { action: 'ask'; known: boolean };

export function planTerminal(state: TerminalState): TerminalPlan {
  if (state === 'none') return { action: 'new' };
  if (state === 'idle') return { action: 'reuse' };
  return { action: 'ask', known: state === 'running' };
}
