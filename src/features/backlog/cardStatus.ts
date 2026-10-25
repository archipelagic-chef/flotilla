import type { BacklogItemView } from '../../webview/protocol';
import { statusLine } from '../chats/activity';
import { readyToMerge } from './backlog';
import type { CardAgent } from './cardAgents';
import { conflictsOf } from './mainDrift';
import { mergeLabel, unmergedWarning } from './merged';
import { turnOf } from './turn';

/**
 * A compact card's one status line (BL-183): what's going on with the ticket, in words, the one mark it keeps when it
 * needs you, and its next step, as one button. The first state that applies wins: a sign that needs you before work
 * going on, work going on before where the ticket is. Shared by the host and the webviews (no node or vscode APIs).
 */
export interface CardStatus {
  text: string;
  /** Needs you: a question (yours to answer or review), a warning (stuck, stopped, not merged) or an error (failing). */
  mark?: 'question' | 'warning' | 'error';
  /** An agent (or the merge's checks) works on it now. */
  working?: boolean;
  next?: CardStep;
}

/** A card's next step: a backlog message the card sends, with the button's label. */
export interface CardStep {
  op: 'accept' | 'start' | 'approve' | 'comment' | 'merge' | 'mergeNext' | 'open';
  label: string;
  icon: string;
}

export type CardStatusItem = Pick<
  BacklogItemView,
  'status' | 'proposed' | 'review' | 'source' | 'merging' | 'merge' | 'checks' | 'mainCheck' | 'supersededBy' | 'startFailed' | 'clash' | 'waitsFor' | 'creating' | 'base' | 'agent' | 'unseenReplies'
>;

const OPEN: CardStep = { op: 'open', label: 'Open', icon: 'go-to-file' };
const START: CardStep = { op: 'start', label: 'Start', icon: 'play' };
const strip = (s: string) => s.replace(/`/g, '');
const rounds = (n: number) => `${n} ${n === 1 ? 'round' : 'rounds'}`;

export function cardStatus(item: CardStatusItem, agents: readonly CardAgent[], queuedBehind = false, now = Date.now()): CardStatus {
  const main = item.base ?? 'main';
  if (item.proposed) return { text: item.proposed.by ? `Proposed by ${item.proposed.by}` : 'Proposed', next: { op: 'accept', label: 'Accept', icon: 'check' } };
  if (item.source) return { text: `${item.source.label} · ${item.source.statusName}` };
  const m = item.merging;
  if (m?.state === 'failed') return { text: `Merge failed${m.reason ? `: ${strip(m.reason)}` : ''}`, mark: 'error', next: OPEN };
  if (item.checks) return { text: `Merging: checks${item.checks.percent !== undefined ? ` ${item.checks.percent}%` : ''}`, working: true };
  if (m?.state === 'resolving') return { text: 'Merging: an agent resolves its conflicts', working: true };
  if (m?.state === 'resolved') return { text: 'Waiting for you: approve the merge', mark: 'question', next: OPEN };
  if (item.startFailed) return { text: `Couldn't start: ${strip(item.startFailed.message)}`, mark: 'error', next: { ...START, label: 'Retry' } };
  const stuck = agents.find((a) => a.stuck);
  if (stuck) return { text: `${stuck.name} looks stuck: ${strip(stuck.stuck!)}`, mark: 'warning', next: OPEN };
  if (unmergedWarning(item, item.merge)) return { text: "Done, but its work isn't merged", mark: 'warning', next: OPEN };
  if (conflictsOf(item).length > 0) return { text: `Conflicts with ${main}`, mark: 'error', next: OPEN };
  // An agent answered a comment of yours while the ticket wasn't open (BL-127): until it's opened.
  const replies = typeof item.unseenReplies === 'number' && item.unseenReplies > 0 ? Math.floor(item.unseenReplies) : 0;
  if (replies) return { text: `${replies} ${replies === 1 ? 'reply' : 'replies'}`, mark: 'question', next: { op: 'open', label: 'Read', icon: 'comment' } };
  const r = item.review;
  const turn = turnOf(item);
  if (turn) {
    switch (turn.kind) {
      case 'asking':
        return { text: 'Waiting for you: answer', mark: 'question', next: { op: 'comment', label: 'Answer', icon: 'comment' } };
      case 'yours':
        if (queuedBehind) return { text: 'Approved · in the merge queue', next: { op: 'mergeNext', label: 'Merge Next', icon: 'git-merge' } };
        if (readyToMerge(item)) return { text: `Approved${r?.reviewer ? ` by ${r.reviewer}` : ''} · ready to merge`, next: { op: 'merge', label: 'Merge', icon: 'git-merge' } };
        return { text: 'Waiting for you: review', mark: 'question', next: { op: 'approve', label: 'Approve', icon: 'check' } };
      case 'agent-review':
        return { text: `In review · ${turn.who} reviewing${r?.round ? ` · ${rounds(r.round)}` : ''}`, working: true };
      case 'agent-revising':
        return { text: `Revising · ${turn.who}${r?.round ? ` · round ${r.round}` : ''}`, working: true };
      case 'stopped':
        return { text: 'Stopped: yours to decide', mark: 'warning', next: OPEN };
      case 'paused':
        return { text: 'Paused', next: OPEN };
    }
  }
  const waiting = agents.find((a) => a.state === 'waiting');
  if (waiting) return { text: `${waiting.name} waits for you`, mark: 'question', next: { op: 'open', label: 'Answer', icon: 'comment' } };
  if (item.clash) return { text: `Held back until ${item.clash.with} is merged` };
  if (item.waitsFor) return { text: `Waits for ${item.waitsFor.join(', ')}` };
  // The agent that did something last says what it does.
  const since = (a: CardAgent) => a.activity?.tool?.since ?? '';
  const live = agents.filter((a) => a.activity).sort((a, b) => since(b).localeCompare(since(a)))[0];
  const line = live?.activity && statusLine(live.activity, now);
  if (live && line) return { text: `${live.name}: ${strip(line)}`, working: true };
  const working = agents.find((a) => a.state === 'working');
  if (working) return { text: `${working.name} working`, working: true };
  const paused = agents.find((a) => a.state === 'paused');
  if (paused) return { text: `${paused.name} paused` };
  if (item.creating) return { text: 'Creating its worktree…', working: true };
  switch (item.status) {
    case 'todo':
      return { text: item.agent?.light && !item.agent.model ? 'To do · light' : 'To do', next: START };
    case 'doing':
      return { text: 'In progress · no agent on it', next: START };
    case 'review':
      return { text: 'In review' };
    case 'done': {
      const merged = item.merge && mergeLabel(item.merge);
      return { text: merged ? `Done · ${merged}` : 'Done' };
    }
  }
}

/** The small signs a card had, as one summary for its line: "2 agents · 3 worktrees". */
export function cardSummary(agents: number, worktrees: number): string | undefined {
  const parts = [agents > 1 && `${agents} agents`, worktrees > 1 && `${worktrees} worktrees`].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
