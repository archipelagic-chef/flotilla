import type { MergeState } from './merge';

/*
 * The states of a merge that waits for a decision (a ticket's `merging`), and what moves each on (BL-150). A merge
 * that needs nothing has no state: it's merged (Done), or it never started. A new path goes into this table and into
 * the scenarios of tests/integration/merge/ together.
 *
 * | State                         | Buttons (mergeActions)              | What moves it on                                                        |
 * | ----------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
 * | (none)                        | Merge to main                       | Merge to main: merged (Done), or conflicts → Resolve with Agent →       |
 * |                               |                                     | resolving; checks fail → failed (checks)                                |
 * | (none), in the train,         | Resolve with Agent (train panel)    | Resolve with Agent → resolving (train); Merge to main merges it alone   |
 * | conflicting                   |                                     |                                                                         |
 * | resolving, agent running      | Cancel                              | the agent ends: resolved; or failed (it stopped short, or committed no  |
 * |                               |                                     | fix and the checks still fail); or merged (no fix, the rerun passed)    |
 * | resolving, agent not running  | Resolve with Agent, Cancel          | Resolve with Agent → resolving (same agent); Cancel → (none)            |
 * | (a window reload)             |                                     |                                                                         |
 * | resolved                      | Approve, Cancel                     | Approve: checks, then merged; checks fail → failed (checks); main moved |
 * |                               |                                     | → failed (reason); in the train: recorded, the train lands it           |
 * | failed, checks                | Fix with Agent, Run the Checks      | Fix with Agent → resolving; Run the Checks Again → merged, or failed    |
 * |                               | Again, Cancel                       | with the new output; Cancel → (none)                                    |
 * | failed, other reason          | Resolve with Agent, Approve, Cancel | Resolve with Agent → resolving; Approve as for resolved; Cancel → (none) |
 */

/** What the ticket's merging panel offers for a merge waiting for a decision. */
export type MergeAction = 'cancel' | 'resolve' | 'recheck' | 'approve';

/**
 * The buttons of a merge's state, in the panel's order, and the one to click next (the primary one: undefined while
 * its agent works). `running`: whether its agent is running in this window.
 */
export function mergeActions(m: Pick<MergeState, 'state' | 'checks'>, running: boolean): { actions: MergeAction[]; next?: MergeAction } {
  const resolving = m.state === 'resolving' && running;
  const actions: MergeAction[] = ['cancel'];
  if (!resolving && m.state !== 'resolved') actions.push('resolve');
  if (m.checks && m.state === 'failed' && !resolving) actions.push('recheck');
  if (m.state !== 'resolving' && (!m.checks || m.state === 'resolved')) actions.push('approve');
  const next = resolving ? undefined : m.state === 'resolved' ? 'approve' : 'resolve';
  return { actions, next };
}
