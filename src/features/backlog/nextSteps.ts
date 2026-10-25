import type { BacklogStatus } from './backlog';

/**
 * What a ticket can do now (BL-154): its main step, the other steps that can work, and a status line saying why when
 * the main step isn't the usual one. The ticket's action row, its review and merge panels and its card show what this
 * gives, so they agree, and a button that can't work isn't shown: the one that can do the job is, in its place.
 * Shared by the host and the webviews (no node or vscode APIs).
 */
export type StepOp =
  | 'start'
  | 'resume'
  | 'openChat'
  | 'stop'
  | 'reviewMyself'
  | 'approve'
  | 'requestChanges'
  | 'run'
  | 'askRunBlock'
  | 'merge'
  | 'updateAndMerge'
  | 'fixCi'
  | 'mergeNext'
  | 'mergeQueueRemove'
  | 'push'
  | 'removeWorktree';

export interface StepState {
  status: BacklogStatus;
  /** Main's name ("main"). */
  base?: string;
  /** Its work is merged. */
  merged?: boolean;
  /** Its branch's files that conflict with main. */
  conflicts?: readonly string[];
  /** CI on its branch: red, or green on a main that moved since. */
  ci?: 'red' | 'moved';
  /** Its place in the merge queue, when it waits there, and how many tickets land before it. */
  queue?: { place: string; ahead: number };
  /** The implementer works on it now. */
  agentWorking?: string;
  /** An agent reviewer works on it now. */
  reviewerWorking?: string;
  /** The work waits for the user's review. */
  yours?: boolean;
  /** Approved (by the user, or as they'd merge it): it can merge. */
  canMerge?: boolean;
  /** It's in review, or approved: the latest run block can be run. */
  reviewing?: boolean;
  /** The agent gave a run block. */
  hasRunBlock?: boolean;
  /** Merged, main has commits its upstream doesn't: Push… */
  unpushed?: boolean;
  /** It has a worktree. */
  hasWorktree?: boolean;
  /**
   * Its agent stopped without a question, to be resumed (BL-198): the tickets it said it waits for, those not merged
   * yet and those merged.
   */
  asking?: { waits: readonly string[]; merged: readonly string[] };
  /** Update from Main and Merge is under way: the part it's at. */
  chained?: 'updating' | 'resolving' | 'checks' | 'merging';
}

export interface NextSteps {
  main?: StepOp;
  others: StepOp[];
  /** Why the main step is this one, when it isn't the usual one. */
  status?: string;
}

/** Each step's button: its label and codicon. */
export const STEP: Record<StepOp, { label: string; icon: string }> = {
  start: { label: 'Start an Agent', icon: 'play' },
  resume: { label: 'Resume', icon: 'debug-continue' },
  openChat: { label: 'Open Chat', icon: 'comment-discussion' },
  stop: { label: 'Stop', icon: 'debug-stop' },
  reviewMyself: { label: 'Review It Myself', icon: 'eye' },
  approve: { label: 'Approve', icon: 'check' },
  requestChanges: { label: 'Request Changes', icon: 'request-changes' },
  run: { label: 'Run', icon: 'play' },
  askRunBlock: { label: 'Ask for a Run Block', icon: 'comment' },
  merge: { label: 'Merge to main', icon: 'git-merge' },
  updateAndMerge: { label: 'Update from Main and Merge', icon: 'sync' },
  fixCi: { label: 'Fix CI with Agent', icon: 'hubot' },
  mergeNext: { label: 'Merge Next', icon: 'git-merge' },
  mergeQueueRemove: { label: 'Remove from Queue', icon: 'close' },
  push: { label: 'Push…', icon: 'cloud-upload' },
  removeWorktree: { label: 'Remove Its Worktree…', icon: 'trash' },
};

const CHAINED: Record<NonNullable<StepState['chained']>, string> = {
  updating: 'Updating from main…',
  resolving: 'Updating from main: its agent resolves the conflicts…',
  checks: 'Checks running…',
  merging: 'Merging…',
};

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

export function nextSteps(s: StepState): NextSteps {
  const main = s.base ?? 'main';
  if (s.merged || s.status === 'done')
    return { others: [...(s.merged && s.unpushed ? ['push' as const] : []), ...(s.hasWorktree ? ['removeWorktree' as const] : [])] };
  // Update from Main and Merge goes on: the part it's at, and what that part needs (an agent's chat, your approval).
  const chained = s.chained && CHAINED[s.chained];
  if (s.agentWorking) return { main: 'openChat', others: ['stop'], status: chained || `${s.agentWorking} is working on it` };
  if (chained && !s.yours) return { others: [], status: chained };
  const run: StepOp[] = s.reviewing ? [s.hasRunBlock ? 'run' : 'askRunBlock'] : [];
  if (s.reviewerWorking)
    return {
      main: 'openChat',
      others: ['reviewMyself', ...run.filter((r) => r === 'run')],
      status: `${s.reviewerWorking} reviews it: Approve and Request Changes come when it's done`,
    };
  // Resume goes on in its chat; Start an Agent starts afresh. It's offered while it waits too: you may know better.
  if (s.asking) return { main: 'resume', others: ['start', ...run], status: resumeStatus(s.asking) };
  const conflicts = s.conflicts?.length ? `Conflicts with ${main} in ${files(s.conflicts.length)}` : undefined;
  if (s.yours) return { main: 'approve', others: ['requestChanges', ...run], status: chained ? `${chained} It merges once you approve` : conflicts };
  if (s.canMerge) {
    if (conflicts) return { main: 'updateAndMerge', others: run, status: `${conflicts}: its agent resolves them, then it merges` };
    if (s.ci === 'red') return { main: 'fixCi', others: run, status: 'CI failed on its branch: an agent fixes it, then it can merge' };
    if (s.ci === 'moved')
      return { main: 'updateAndMerge', others: run, status: `${capital(main)} moved since CI ran: it updates, CI runs again, then it merges` };
    // Merge to main lands the tickets ahead first: Merge Next is the step that lands it alone.
    if (s.queue?.ahead) return { main: 'mergeNext', others: ['merge', 'mergeQueueRemove', ...run], status: `${s.queue.place} in the merge queue` };
    if (s.queue) return { main: 'merge', others: ['mergeQueueRemove', ...run], status: `${s.queue.place} in the merge queue` };
    return { main: 'merge', others: run };
  }
  if (s.status === 'todo' || s.status === 'doing') return { main: 'start', others: run };
  return { others: run };
}

const list = (ids: readonly string[]) => (ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}` : (ids[0] ?? ''));

function resumeStatus(a: NonNullable<StepState['asking']>): string | undefined {
  if (a.waits.length) return `Waits for ${list(a.waits)} to be merged`;
  if (a.merged.length) return `${list(a.merged)} ${a.merged.length > 1 ? 'are' : 'is'} merged: resume it`;
  return undefined;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A step's label, with main's name: "Merge to develop". */
export function stepLabel(op: StepOp, base = 'main'): string {
  const label = STEP[op].label;
  return label.replace(/\bmain\b/, base).replace(/\bMain\b/, capital(base));
}
