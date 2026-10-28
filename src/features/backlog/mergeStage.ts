import type { MergeState } from './merge';

/**
 * Where a ticket's merge is, in words (BL-229): the card, the "Needs you" row and the notifications all read it here,
 * so they say the same. failed: its checks failed; stopped: the user stopped them; resolving: an agent is at its
 * conflicts (or its checks); resolved: the agent's resolution waits for the user to approve it. Shared by the host and
 * the webviews (no node or vscode APIs).
 */
export interface MergeStage {
  stage: 'failed' | 'stopped' | 'resolving' | 'resolved';
  /** What the card says. */
  text: string;
  /** What the "Needs you" row says: the card's words, with what to do. */
  line: string;
  mark?: 'question' | 'warning' | 'error';
  /** It waits on the user. */
  needsYou: boolean;
}

const strip = (s: string) => s.replace(/`/g, '');

/** Whether the user stopped a failed merge's checks: its last run's record, or (from before runs were kept) its reason. */
function stoppedChecks(m: Pick<MergeState, 'reason' | 'checks'>): boolean {
  const last = m.checks?.runs?.at(-1);
  if (last) return !!last.stopped;
  return /^you stopped the checks\b/i.test(m.reason ?? '');
}

export function mergeStage(m: Pick<MergeState, 'state' | 'reason' | 'checks'> | undefined): MergeStage | undefined {
  if (!m) return undefined;
  switch (m.state) {
    case 'failed': {
      if (stoppedChecks(m)) {
        const text = 'Merge stopped: you stopped its checks';
        return { stage: 'stopped', text, line: `${text}. Run them again, or cancel it.`, mark: 'warning', needsYou: true };
      }
      const text = `Merge failed${m.reason ? `: ${strip(m.reason)}` : ''}`;
      return { stage: 'failed', text, line: text, mark: 'error', needsYou: true };
    }
    case 'resolving': {
      const text = 'Merging: an agent resolves its conflicts';
      return { stage: 'resolving', text, line: text, needsYou: false };
    }
    case 'resolved': {
      const text = 'Waiting for you: approve the merge';
      return { stage: 'resolved', text, line: text, mark: 'question', needsYou: true };
    }
  }
}
