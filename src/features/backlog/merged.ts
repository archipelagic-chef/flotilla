import type { BacklogItem } from './backlog';

/**
 * Whether an item's work is in the base branch. Read from git, never stored (mergeReader.ts reads it). This module is
 * also used in webviews: no node APIs.
 */

/**
 * A branch of an item, against the base: merged (its commits are in the base), unmerged (commits the base doesn't
 * have), or empty (never had a commit: a branch just started is in the base too, so it isn't "merged").
 */
export type BranchMerge = 'merged' | 'unmerged' | 'empty';

export interface BranchState {
  branch: string;
  state: BranchMerge;
  /** Commits the base doesn't have (unmerged branches). */
  commits: number;
}

/**
 * merged: all of the item's work is in the base; partly: some of its branches are (an epic's); unmerged: none is;
 * none: there's no work to merge (no branch, or only empty ones).
 */
export interface MergeInfo {
  /** The base branch, as it's named here ("main", or "origin/main"). */
  base: string;
  state: 'merged' | 'partly' | 'unmerged' | 'none';
  /** Commits on the unmerged branches (the base doesn't have them). */
  commits: number;
  branches: BranchState[];
}

/** The merge state of a set of branches: empty ones don't count as work. */
export function summarizeMerge(base: string, branches: readonly BranchState[]): MergeInfo {
  const work = branches.filter((b) => b.state !== 'empty');
  const merged = work.filter((b) => b.state === 'merged').length;
  const state: MergeInfo['state'] = !work.length ? 'none' : merged === work.length ? 'merged' : merged === 0 ? 'unmerged' : 'partly';
  const commits = work.filter((b) => b.state === 'unmerged').reduce((n, b) => n + b.commits, 0);
  return { base, state, commits, branches: [...branches] };
}

/** The base's name for people: without its remote ("origin/main" is main). */
export function baseName(base: string): string {
  return base.replace(/^origin\//, '');
}

/** The line that says it on a card or in a ticket: "merged into main", "not merged (3 commits)", "partly merged". */
export function mergeLabel(merge: MergeInfo): string | undefined {
  switch (merge.state) {
    case 'merged':
      return `merged into ${baseName(merge.base)}`;
    case 'partly':
      return 'partly merged';
    case 'unmerged':
      return `not merged (${merge.commits} ${merge.commits === 1 ? 'commit' : 'commits'})`;
    case 'none':
      return undefined;
  }
}

/** Review states in which an agent or a reviewer is at the item now: its work doesn't move to Done under them. */
const BUSY_REVIEW: ReadonlySet<string> = new Set(['working', 'reviewing', 'revising', 'asking', 'paused']);

/**
 * Whether an item's work being merged moves it to Done: it's all merged, it isn't Done yet, and no agent is working on
 * it (proposals wait to be accepted first). Only work in review (or seen unmerged since Flotilla started: wasOpen) moves:
 * a Done item reopened to do more work, its old branch still merged, stays where it's put.
 */
export function movesToDone(item: Pick<BacklogItem, 'status' | 'review' | 'proposed'>, merge: MergeInfo | undefined, wasOpen = false): boolean {
  return (
    !!merge &&
    merge.state === 'merged' &&
    (item.status === 'review' || wasOpen) &&
    item.status !== 'done' &&
    !item.proposed &&
    !BUSY_REVIEW.has(item.review?.state ?? '')
  );
}

/** A Done item whose work isn't all merged: the warning in its ticket (partly or not merged; a superseded one has none). */
export function unmergedWarning(item: Pick<BacklogItem, 'status' | 'supersededBy'>, merge: MergeInfo | undefined): boolean {
  return item.status === 'done' && !item.supersededBy && !!merge && (merge.state === 'unmerged' || merge.state === 'partly');
}
