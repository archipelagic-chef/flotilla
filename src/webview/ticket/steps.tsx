import { conflictsOf } from '../../features/backlog/mainDrift';
import {
  type NextSteps,
  nextSteps,
  STEP,
  stepLabel,
  type StepOp,
  type StepState,
} from '../../features/backlog/nextSteps';
import { latestCi } from '../../features/ci/summary';
import type { TicketCiView, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { ActionButton } from './actions';
import { LandResolvingButton, MergeButton } from './mergePanel';

/** Its branch's latest CI run, when it failed: Fix CI with Agent fixes that one. */
export function redRun(ci: TicketCiView | undefined): { branch: string; run: number } | undefined {
  for (const w of ci?.worktrees ?? []) {
    const run = latestCi(w.view)?.run;
    if (run?.status === 'failure') return { branch: w.branch, run: run.id };
  }
  return undefined;
}

/** The ticket's state as nextSteps reads it. */
export function stepState(ticket: TicketView, ci?: TicketCiView): StepState {
  const r = ticket.review;
  const working = ticket.agents.find((a) => a.state === 'working');
  // Its reviewer agent's start waits in the agents' queue (BL-212): its implementer is done.
  const reviewQueued = ticket.item.status === 'review' && ticket.queued?.kind === 'review' && r?.state !== 'reviewing';
  const stop = ticket.mergeStop;
  return {
    status: ticket.item.status,
    base: ticket.mergeInto ?? ticket.updateFromMain?.base,
    merged: !!ticket.item.merged,
    conflicts: [...new Set(conflictsOf(ticket.item).flatMap((b) => b.conflicts))],
    ci: stop?.kind === 'moved' ? 'moved' : stop?.kind === 'failed' || redRun(ci) ? 'red' : undefined,
    queue: ticket.mergeQueue && { place: ticket.mergeQueue.place, ahead: ticket.mergeQueue.ahead.length },
    ...(reviewQueued ? { reviewQueued } : {}),
    agentWorking:
      !reviewQueued && (r?.state === 'revising' || r?.state === 'working')
        ? (r.implementer ?? 'Its agent')
        : r?.state !== 'reviewing' && working
          ? (working.agent ?? 'An agent')
          : undefined,
    reviewerWorking: r?.state === 'reviewing' ? (r.reviewer ?? 'The reviewer') : undefined,
    yours: r?.state === 'yours' || (r?.state === 'approved' && !r.byUser),
    canMerge: ticket.canMerge,
    reviewing: !ticket.remote && (ticket.item.status === 'review' || r?.state === 'approved'),
    hasRunBlock: !!ticket.run,
    unpushed: !!ticket.unpushed,
    hasWorktree: ticket.worktrees.length > 0,
    asking: ticket.resume && {
      waits: ticket.resume.after.filter((d) => !d.merged).map((d) => d.id),
      merged: ticket.resume.after.filter((d) => d.merged).map((d) => d.id),
    },
    chained: ticket.chain && ticket.chain === 'merging' && ticket.mergeChecks ? 'checks' : ticket.chain,
    ...(ticket.item.status === 'doing' && ticket.children.length ? { epicStarted: true } : {}),
  };
}

export const ticketSteps = (ticket: TicketView, ci?: TicketCiView): NextSteps => nextSteps(stepState(ticket, ci));

/** What a merge step sends: Update from Main and Merge, Fix CI with Agent, Merge Next. */
const MESSAGE: Partial<Record<StepOp, (ci: TicketCiView | undefined) => TicketWebviewMessage>> = {
  updateAndMerge: () => ({ type: 'updateAndMerge' }),
  fixCi: (ci) => ({ type: 'mergeCiFix', ...redRun(ci) }),
  mergeNext: () => ({ type: 'mergeNext' }),
  mergeQueueRemove: () => ({ type: 'mergeQueueRemove' }),
};

const TIP: Partial<Record<StepOp, string>> = {
  updateAndMerge: 'Merges main into its branch (its agent resolves the conflicts, when there are any), then merges it: the checks first, as Merge to main does',
  fixCi: "An agent reads the failed job's log, fixes it on the branch and pushes; CI runs again",
  mergeNext: 'Moves it to the front of the merge queue: the train is rebuilt in the new order',
  mergeQueueRemove: 'Takes it out of the merge queue: the train is rebuilt without it; nothing is reverted',
};

/**
 * The ticket's merge step, where Merge to main is: Merge to main when it can work, else the step that does the job
 * (Update from Main and Merge on conflicts or a main that moved, Fix CI with Agent on red CI, Merge Next in the queue).
 */
export function MergeStep({ ticket, ci, steps }: { ticket: TicketView; ci?: TicketCiView; steps: NextSteps }) {
  const into = ticket.mergeInto ?? 'main';
  const op = steps.main;
  if (ticket.mergeProgress) return <MergeButton into={into} progress={ticket.mergeProgress} />;
  if (!op || (op !== 'merge' && !MESSAGE[op])) return null;
  return (
    <>
      {op === 'merge' ? (
        <>
          <MergeButton into={into} />
          <LandResolvingButton />
        </>
      ) : (
        <ActionButton class="button" message={MESSAGE[op]!(ci)} working={op === 'updateAndMerge' ? 'Updating…' : 'Starting…'} title={TIP[op]}>
          <i class={`codicon codicon-${STEP[op].icon}`} /> {stepLabel(op, into)}
        </ActionButton>
      )}
      {op !== 'merge' && steps.others.includes('merge') && (
        <>
          <MergeButton into={into} secondary />
          <LandResolvingButton />
        </>
      )}
      {steps.others
        .filter((o) => MESSAGE[o])
        .map((o) => (
          <ActionButton key={o} class="button secondary" message={MESSAGE[o]!(ci)} working="Working…" title={TIP[o]}>
            {stepLabel(o, into)}
          </ActionButton>
        ))}
    </>
  );
}

/** Why the main step is the one it is, under the panel's sentence. */
export function StepStatus({ steps }: { steps: NextSteps }) {
  return steps.status ? <span class="muted step-status"> {steps.status}</span> : null;
}
