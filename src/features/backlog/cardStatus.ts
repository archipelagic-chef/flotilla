import type { BacklogItemView } from '../../webview/protocol';
import { statusLine } from '../chats/activity';
import { ordinal } from './agentQueue';
import { readyToMerge } from './backlog';
import type { CardAgent } from './cardAgents';
import { conflictsOf } from './mainDrift';
import { mergeLabel, unmergedWarning } from './merged';
import { mergeStage } from './mergeStage';
import { nextSteps, STEP } from './nextSteps';
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
  /** Why, at more length: the status line's hover. */
  tip?: string;
}

/** A card's next step: a backlog message the card sends, with the button's label. */
export interface CardStep {
  op: 'accept' | 'reopen' | 'start' | 'resume' | 'approve' | 'comment' | 'merge' | 'mergeNext' | 'updateAndMerge' | 'open' | 'stopCheck';
  label: string;
  icon: string;
}

export type CardStatusItem = Pick<
  BacklogItemView,
  | 'status'
  | 'proposed'
  | 'review'
  | 'source'
  | 'merging'
  | 'merge'
  | 'checks'
  | 'mainCheck'
  | 'supersededBy'
  | 'startFailed'
  | 'clash'
  | 'waitsFor'
  | 'waitsOn'
  | 'depsDiscarded'
  | 'parts'
  | 'shaping'
  | 'resume'
  | 'creating'
  | 'base'
  | 'agent'
  | 'unseenReplies'
  | 'discarded'
  | 'queued'
  | 'checking'
  | 'checkStopped'
>;

const OPEN: CardStep = { op: 'open', label: 'Open', icon: 'go-to-file' };
const START: CardStep = { op: 'start', label: 'Start', icon: 'play' };
/** When it was discarded (BL-209): "Discarded Oct 26, 2026". */
export function discardedLabel(at: string): string {
  return `Discarded ${new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}
const strip = (s: string) => s.replace(/`/g, '');
const rounds = (n: number) => `${n} ${n === 1 ? 'round' : 'rounds'}`;

export function cardStatus(item: CardStatusItem, agents: readonly CardAgent[], queuedBehind = false, now = Date.now()): CardStatus {
  const main = item.base ?? 'main';
  if (item.proposed) {
    // Why the autopilot doesn't take it (BL-205): it waits to be accepted, and its discussion, if any, ends then.
    const by = item.proposed.by ? `Proposed by ${item.proposed.by}` : 'Proposed';
    const talk = item.shaping?.agent;
    return {
      text: talk ? `${by} · in discussion with ${talk}` : `${by} · waits to be accepted`,
      tip: `The autopilot takes it once you accept it${talk ? ', which ends the discussion' : ''}.`,
      next: { op: 'accept', label: 'Accept', icon: 'check' },
    };
  }
  if (item.source) return { text: `${item.source.label} · ${item.source.statusName}` };
  if (item.discarded) return { text: discardedLabel(item.discarded.at), next: { op: 'reopen', label: 'Reopen', icon: 'history' } };
  const merge = mergeStage(item.merging);
  if (merge && (merge.stage === 'failed' || merge.stage === 'stopped')) return { text: merge.text, mark: merge.mark, next: OPEN };
  if (item.checks) return { text: `Merging: checks${item.checks.percent !== undefined ? ` ${item.checks.percent}%` : ''}`, working: true };
  if (merge?.stage === 'resolving') return { text: merge.text, working: true };
  if (merge?.stage === 'resolved') return { text: merge.text, mark: merge.mark, next: OPEN };
  if (item.startFailed) return { text: `Couldn't start: ${strip(item.startFailed.message)}`, mark: 'error', next: { ...START, label: 'Retry' } };
  const stuck = agents.find((a) => a.stuck);
  if (stuck) return { text: `${stuck.name} looks stuck: ${strip(stuck.stuck!)}`, mark: 'warning', next: OPEN };
  if (unmergedWarning(item, item.merge)) return { text: "Done, but its work isn't merged", mark: 'warning', next: OPEN };
  const conflicts = conflictsOf(item).flatMap((b) => b.conflicts);
  if (conflicts.length > 0) {
    // Approved, Merge can't work: the step that does the job, as the ticket shows it (BL-154).
    const steps = readyToMerge(item) ? nextSteps({ status: item.status, base: main, canMerge: true, conflicts: [...new Set(conflicts)] }) : undefined;
    if (steps?.main === 'updateAndMerge')
      return { text: steps.status!, mark: 'error', next: { op: 'updateAndMerge', label: 'Update and Merge', icon: STEP.updateAndMerge.icon } };
    return { text: `Conflicts with ${main}`, mark: 'error', next: OPEN };
  }
  // An agent answered a comment of yours while the ticket wasn't open (BL-127): until it's opened.
  const replies = typeof item.unseenReplies === 'number' && item.unseenReplies > 0 ? Math.floor(item.unseenReplies) : 0;
  if (replies) return { text: `${replies} ${replies === 1 ? 'reply' : 'replies'}`, mark: 'question', next: { op: 'open', label: 'Read', icon: 'comment' } };
  const r = item.review;
  const turn = turnOf(item);
  if (turn) {
    switch (turn.kind) {
      case 'asking': {
        // Its agent stopped without a question (BL-198): Resume, with what it waits for.
        if (item.resume) {
          const steps = nextSteps({ status: item.status, base: main, asking: item.resume });
          return {
            text: steps.status ?? 'Waiting for you: resume it',
            mark: item.resume.waits.length ? undefined : 'question',
            next: { op: 'resume', label: STEP.resume.label, icon: STEP.resume.icon },
          };
        }
        return { text: 'Waiting for you: answer', mark: 'question', next: { op: 'comment', label: 'Answer', icon: 'comment' } };
      }
      case 'yours':
        if (queuedBehind) return { text: 'Approved · in the merge queue', next: { op: 'mergeNext', label: 'Merge Next', icon: 'git-merge' } };
        if (readyToMerge(item))
          return { text: `Approved${r?.reviewer ? ` by ${r.reviewer}` : ''} · ready to merge`, next: { op: 'merge', label: 'Merge', icon: 'git-merge' } };
        return { text: 'Waiting for you: review', mark: 'question', next: { op: 'approve', label: 'Approve', icon: 'check' } };
      case 'agent-review':
        // Its reviewer agent waits for a free agent (BL-212), or for free memory.
        if (turn.queued && item.queued)
          return {
            text: `Queued for an agent review · ${ordinal(item.queued.place)} in line`,
            tip: `A reviewer agent takes it up when ${item.queued.reason === 'memory' ? "there's free memory" : 'one is free'}.`,
          };
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
  if (item.waitsFor) {
    // Where each one stands (BL-205), so a stuck dependency shows on the tickets it holds up.
    const stands = new Map(item.waitsOn?.map((w) => [w.id, w.standing]));
    const deps = item.waitsFor.map((id) => (stands.get(id) ? `${id} (${stands.get(id)})` : id));
    return { text: `Waits for ${deps.join(', ')}`, tip: `The autopilot takes it once ${item.waitsFor.length === 1 ? 'that one is' : 'they are'} merged.` };
  }
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
      // What the autopilot passes over, and why (BL-205): an epic (its parts it takes), a ticket in a discussion.
      if (item.parts?.total)
        return {
          text: `Epic · ${item.parts.done} of ${item.parts.total} parts done`,
          tip: 'The autopilot takes its parts, not the epic: start a part, not the whole.',
        };
      if (item.checking && item.checkStopped) return { text: `Stopping the check against ${item.checking}'s change…`, working: true };
      if (item.checking)
        return {
          text: `Checking against ${item.checking}'s change…`,
          tip: `An agent checks it against ${item.checking}'s change and what's on ${main}: the autopilot takes it once that's done. Stop check releases it, unchecked.`,
          working: true,
          next: { op: 'stopCheck', label: 'Stop check', icon: 'debug-stop' },
        };
      if (item.shaping?.agent)
        return {
          text: `In discussion with ${item.shaping.agent}`,
          tip: "The autopilot doesn't take it while it's discussed: accepting it or starting it ends the discussion.",
          next: START,
        };
      // What it depended on was discarded (BL-235): it waits for it no more, and is taken like any other.
      if (item.depsDiscarded?.length)
        return {
          text: `Depended on ${item.depsDiscarded.join(', ')}, discarded`,
          tip: `It no longer waits for ${item.depsDiscarded.length === 1 ? 'it' : 'them'}: check that it still makes sense without that work.`,
          next: START,
        };
      return { text: item.agent?.light && !item.agent.model ? 'To do · light' : 'To do', next: START };
    case 'doing':
      // An epic is in progress with its parts (BL-239): no agent of its own is missing.
      if (item.parts?.total)
        return {
          text: `Epic · ${item.parts.done} of ${item.parts.total} parts done`,
          tip: 'Its parts are worked on, not the epic: it moves to Done with the last of them.',
        };
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
