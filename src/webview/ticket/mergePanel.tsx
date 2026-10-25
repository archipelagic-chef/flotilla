import type { ComponentChildren } from 'preact';
import type { BacklogStatus } from '../../features/backlog/backlog';
import { mergeLabel, unmergedWarning } from '../../features/backlog/merged';
import { mergeActions } from '../../features/backlog/mergeStates';
import { capitalize, conflictsOf } from '../../features/backlog/mainDrift';
import type { TicketCiView, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { ciWord } from '../../features/ci/summary';
import { ciMovedPast, type CiStop } from '../../features/backlog/ciStop';
import { act, ActionButton, send, UpdateFromButton, useWorking, WorkingTag } from './actions';
import { STATUSES } from './header';
import { ChecksRuns } from './checksPanel';
import './mergePanel.css';

/** The ticket without its merge's CI stop once its CI shows other runs on the tip it stopped on (a re-run). */
export function withCiStop(ticket: TicketView, ci: TicketCiView | undefined): TicketView {
  const stop = ticket.mergeStop;
  const view = stop && ci?.worktrees.find((w) => w.branch === stop.branch)?.view;
  return stop && view?.kind === 'runs' && ciMovedPast(stop, view.runs) ? { ...ticket, mergeStop: undefined } : ticket;
}

/** A link the host opens (job logs, runs on GitHub). */
function HostLink({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        send({ type: 'openHref', href });
      }}
    >
      {children}
    </a>
  );
}

/**
 * Why Merge to main stopped on CI (BL-112), under its button: red CI with the failed jobs' logs and Fix with Agent, or
 * the base moved on with Update from Main. It holds until the branch's tip or its CI changes.
 */
export function MergeStop({ stop }: { stop: CiStop }) {
  if (stop.kind === 'moved')
    return (
      <div class="merge-stop">
        <i class="codicon codicon-warning" />
        <span class="review-text">
          <strong>Not merged:</strong> {stop.base} has moved on since <code>{stop.branch}</code> took it in, so CI checked another tree than the merge's. Update
          from {capitalize(stop.base)}, then merge when CI passes.
        </span>
        <ActionButton class="button" message={{ type: 'updateFromMain' }} working="Updating…" title={`Rebases the branch onto ${stop.base}; it's pushed, and CI runs again`}>
          <i class="codicon codicon-sync" /> Update from {capitalize(stop.base)}
        </ActionButton>
      </div>
    );
  const cancelled = stop.runs.every((r) => r.status === 'cancelled');
  const runLink = (r: Extract<CiStop, { kind: 'failed' }>['runs'][number]) => <HostLink href={r.url}>{`${r.workflow} #${r.number}`}</HostLink>;
  const word = (status: string) => (status === 'cancelled' ? 'Cancelled' : 'Failed');
  return (
    <div class="merge-stop">
      <i class="codicon codicon-error" />
      <span class="review-text">
        <strong>Not merged:</strong> CI {cancelled ? 'was cancelled' : 'failed'} on <code>{stop.branch}</code> at <code>{stop.tip.slice(0, 7)}</code>. There's no
        merging past red CI.
        <ul class="merge-stop-jobs">
          {stop.jobs.length
            ? stop.jobs.map((j) => {
                const run = stop.runs.find((r) => r.id === j.runId);
                return (
                  <li key={j.jobId}>
                    {word(j.status)}: <HostLink href={j.url}>{j.name}</HostLink>
                    {run && <> in {runLink(run)}</>}
                  </li>
                );
              })
            : stop.runs.map((r) => (
                <li key={r.id}>
                  {word(r.status)}: {runLink(r)}
                </li>
              ))}
        </ul>
      </span>
      <ActionButton class="button" message={{ type: 'mergeCiFix' }} working="Starting…" title="An agent reads the failed job's log, fixes it on the branch and pushes; CI runs again">
        <i class="codicon codicon-hubot" /> Fix with Agent
      </ActionButton>
    </div>
  );
}

/**
 * Its place in the merge queue (BL-140), under Merge to main: what the train says of it (it merges cleanly onto main
 * and the tickets ahead, or conflicts with them), and Remove from Queue.
 */
export function QueuePlace({ queue }: { queue: NonNullable<TicketView['mergeQueue']> }) {
  const conflicts = !!queue.state?.startsWith('Conflicts');
  return (
    <div class={`merge-queue${conflicts ? ' conflicts' : ''}`}>
      <i class={`codicon ${conflicts ? 'codicon-warning' : 'codicon-list-ordered'}`} />
      <span class="review-text">
        <strong>{queue.place} in the merge queue.</strong> {queue.state ? <Code text={queue.state} /> : 'The merge train is being built.'}
        {!conflicts && queue.ahead.length > 0 && <> Merge to main lands {queue.ahead.join(', ')} first.</>}
        {conflicts && <> It waits: Resolve with Agent resolves them in its merge in the train (its branch isn't changed), or Merge to main merges it onto main as it is.</>}
      </span>
      {conflicts && (
        <ActionButton
          class="button"
          message={{ type: 'mergeQueueResolve' }}
          working="Starting…"
          title="An agent resolves the conflicts in its merge in the train, onto main and the tickets ahead; approved, the resolution is recorded and reused"
        >
          <i class="codicon codicon-hubot" /> Resolve with Agent
        </ActionButton>
      )}
      {queue.ahead.length > 0 && (
        <ActionButton class="button secondary" message={{ type: 'mergeNext' }} working="Moving…" title="Moves it to the front of the merge queue: the train is rebuilt in the new order">
          Merge Next
        </ActionButton>
      )}
      <ActionButton class="button secondary" message={{ type: 'mergeQueueRemove' }} working="Removing…" title="Takes it out of the merge queue: the train is rebuilt without it; nothing is reverted">
        Remove from Queue
      </ActionButton>
    </div>
  );
}

/** A text with `code` spans. */
function Code({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/** Merge to main: it says it's merging, or what it waits behind (another ticket's merge), until its merge ends (BL-101). */
export function MergeButton({ into, progress }: { into: string; progress?: TicketView['mergeProgress'] }) {
  const message: TicketWebviewMessage = { type: 'merge' };
  const clicked = useWorking(message);
  // The host's word first (it lasts across reopening the ticket); from the click until then, the click's.
  const label = (progress && (progress.ci ? 'Merges when CI passes' : progress.waitsFor ? `Waiting for ${progress.waitsFor}…` : 'Merging…')) ?? clicked;
  if (progress?.ci) return <CiWait into={into} runs={progress.ci} />;
  return (
    <button
      class="button"
      disabled={!!label}
      aria-busy={!!label}
      onClick={() => act(message, 'Merging…')}
      title="Merges its branch in a temporary worktree (git merge --no-ff), runs the checks there, then moves the base branch to the merge. Nothing is pushed."
    >
      <i class="codicon codicon-git-merge" /> Merge to {into}
      {label && <WorkingTag label={label} />}
    </button>
  );
}

/**
 * Merge to main waiting for CI to pass (BL-105), and Cancel. It merges once the runs are green; their progress is in
 * its tooltip, and live in the ticket's CI below.
 */
function CiWait({ into, runs }: { into: string; runs: NonNullable<NonNullable<TicketView['mergeProgress']>['ci']> }) {
  const progress = runs.length ? runs.map((r) => `${r.workflow} #${r.number} ${ciWord(r.status)}`).join(', ') : "GitHub hasn't started CI yet";
  return (
    <>
      <button class="button merge-ci-wait" disabled aria-busy title={`Merges into ${into} once every run on the branch's pushed tip has passed; nothing runs locally.\n${progress}`}>
        <i class="codicon codicon-git-merge" /> Merge to {into}
        <WorkingTag label="Merges when CI passes" />
      </button>
      <ActionButton class="button secondary" message={{ type: 'mergeCiCancel' }} working="Cancelling…" title="Stop waiting for CI: nothing is merged">
        Cancel
      </ActionButton>
    </>
  );
}

/** When the checks failed: "Oct 19, 20:16". */
const failedAt = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * A merge of the ticket's branch waiting for a decision: its conflicts being resolved, or resolved for you to approve;
 * or its checks failing (BL-65), with their output, to fix with an agent.
 */
export function MergingPanel({ ticket }: { ticket: TicketView }) {
  const m = ticket.merging!;
  const agent = m.agent ?? 'An agent';
  const resolving = m.state === 'resolving' && m.running;
  const checks = m.checks;
  const { actions } = mergeActions(m, m.running);
  // With failing checks the agent fixes them; with conflicts, it resolves them.
  const work = checks ? 'fixing the checks that fail on the merge' : 'resolving the conflicts';
  const [icon, cls, text] = resolving
    ? ['git-merge', 'working', `${agent} is ${work}, in a temporary worktree; it reports below.`]
    : m.state === 'resolved'
      ? checks
        ? ['pass', 'waiting', `${agent} fixed the checks (its report is below). Approve the fix: the checks run again, then ${m.base} moves to the merge.`]
        : m.train
          ? ['pass', 'waiting', `${agent} resolved the conflicts (its report is below). Approve the resolution: it's recorded, the merge train is rebuilt with it, and the ticket lands from the train.`]
          : ['pass', 'waiting', `${agent} resolved the conflicts (its report is below). Approve the resolution: the checks run, then ${m.base} moves to the merge.`]
      : m.state === 'resolving' && m.paused
        ? ['debug-pause', 'waiting', `${agent} is paused ${work}; its chat is kept. Resume goes on with it there.`]
      : m.state === 'resolving'
        ? ['debug-pause', 'stopped', `${agent} isn't running anymore, and the ${checks ? 'checks aren\'t fixed' : 'conflicts aren\'t resolved'}.`]
        : checks && m.reason?.startsWith('the checks failed')
          ? ['error', 'stopped', `The checks (${checks.command}) fail on the merge, though each side passed alone. Nothing changed; the merge is kept in a temporary worktree.`]
          : ['warning', 'stopped', `Stopped: ${m.reason ?? 'the merge needs you.'}`];
  return (
    <>
      <div class={`review-panel ${cls}`}>
        <i class={`codicon codicon-${icon}${resolving ? ' pulse' : ''}`} />
        <span class="review-text">
          <strong>Merging into {m.train ? `${[m.base, ...m.train.ahead].join(' + ')} (the merge train)` : m.base}</strong> {text}
          {checks?.at && m.state === 'failed' && <span class="muted"> The checks failed on {failedAt(checks.at)}.</span>}
        </span>
        <ActionButton class="button secondary" message={{ type: 'mergeCancel' }} working="Cancelling…" title="Stops its agent and removes the temporary worktree; nothing changes">
          <i class="codicon codicon-close" /> Cancel
        </ActionButton>
        {actions.includes('pause') && (
          <ActionButton class="button secondary" message={{ type: 'mergePause' }} working="Pausing…" title="Pauses its agent: its chat is kept, and Resume goes on with it there">
            <i class="codicon codicon-debug-pause" /> Pause
          </ActionButton>
        )}
        {actions.includes('resume') && (
          <ActionButton class="button" message={{ type: 'mergeResume' }} working="Resuming…" title="Its agent goes on in its chat, in the merge's temporary worktree">
            <i class="codicon codicon-debug-continue" /> Resume
          </ActionButton>
        )}
        {actions.includes('resolve') && (
          <ActionButton
            class="button"
            message={{ type: 'mergeResolve' }}
            working="Starting…"
            title={
              checks
                ? 'An agent fixes the merge, given the failing output and the tickets of both sides: it keeps both intents (or asks you here), and reports here for you to approve'
                : "An agent resolves the conflicts, keeping both sides' intent, and reports here for you to approve"
            }
          >
            <i class="codicon codicon-hubot" /> {checks ? 'Fix with Agent' : 'Resolve with Agent'}
          </ActionButton>
        )}
        {actions.includes('recheck') && (
          <ActionButton
            class="button secondary"
            message={{ type: 'mergeRecheck' }}
            working="Running the checks…"
            title="Runs the checks again on the merge as it is (a failure that was only a loaded machine's goes away): passing, the base branch moves to the merge"
          >
            <i class="codicon codicon-refresh" /> Run the Checks Again
          </ActionButton>
        )}
        {actions.includes('approve') && (
          <ActionButton
            class={`button${m.state === 'resolved' ? '' : ' secondary'}`}
            message={{ type: 'mergeApprove' }}
            working="Running the checks…"
            title="Runs the checks on the merge, then moves the base branch to it"
          >
            <i class="codicon codicon-check" /> {checks ? 'Approve Fix' : 'Approve Resolution'}
          </ActionButton>
        )}
      </div>
      {checks?.runs?.length && !ticket.mergeChecks ? <ChecksRuns runs={checks.runs} /> : null}
      {checks && (
        <details class="merge-output" open={m.state === 'failed' && !checks.runs?.some((r) => r.failures.length)}>
          <summary>The checks' output (its end{checks.runs?.length ? '; Show All has all of it' : ''})</summary>
          <pre>{checks.output.trim() || '(no output)'}</pre>
        </details>
      )}
    </>
  );
}

/** A merged ticket: where it went, and pushing the base branch (asks first). */
export function MergedPanel({ ticket }: { ticket: TicketView }) {
  const m = ticket.item.merged!;
  const u = ticket.unpushed;
  return (
    <div class="review-panel done">
      <i class="codicon codicon-git-merge" />
      <span class="review-text">
        <strong>Merged into {m.into}</strong> {m.commit.slice(0, 7)} · {new Date(m.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        {u ? ` · ${u.count} commit${u.count === 1 ? '' : 's'} not on ${u.remote} yet` : ''}
      </span>
      {u && (
        <ActionButton class="button secondary" message={{ type: 'push' }} working="Pushing…" title={`Pushes ${u.base} to ${u.remote} (asks first)`}>
          <i class="codicon codicon-cloud-upload" /> Push…
        </ActionButton>
      )}
    </div>
  );
}

/** A clean-up of the ticket's history in progress: how far it is; compare, finish or cancel it. */
export function CleanUpPanel({ ticket }: { ticket: TicketView }) {
  const r = ticket.rewrite!;
  const same = !r.differs.length;
  const ready = same && r.cleanCommits > 0 && !r.changes;
  const who = r.by === 'agent' ? (r.agent ? `${r.agent} (an agent) is` : 'An agent is') : 'You are';
  const state = !r.cleanCommits
    ? 'No clean commits yet.'
    : same
      ? r.changes
        ? `${r.cleanCommits} clean commit${r.cleanCommits === 1 ? '' : 's'}, with the same files; ${r.changes} uncommitted change${r.changes === 1 ? '' : 's'} left there.`
        : `${r.cleanCommits} clean commit${r.cleanCommits === 1 ? '' : 's'}, with the same files as ${r.branch}: ready to finish.`
      : `${r.cleanCommits} clean commit${r.cleanCommits === 1 ? '' : 's'} so far; ${r.differs.length} file${r.differs.length === 1 ? '' : 's'} still differ${r.differs.length === 1 ? 's' : ''}.`;
  return (
    <div class={`review-panel ${ready ? 'done' : 'working'}`}>
      <i class={`codicon codicon-${ready ? 'pass-filled' : 'wand'}`} />
      <span class="review-text">
        <strong>Cleaning up the history</strong> {who} rewriting the {r.commits} commit{r.commits === 1 ? '' : 's'} of {r.branch} in {r.clean}. {state}
      </span>
      {!same && r.cleanCommits > 0 && (
        <ActionButton class="button secondary" message={{ type: 'compareCleanUp' }} working="Comparing…" title="What still differs between the clean history and the branch">
          <i class="codicon codicon-diff" /> Compare
        </ActionButton>
      )}
      <ActionButton
        class="button secondary"
        message={{ type: 'cancelCleanUp' }}
        working="Cancelling…"
        title="Removes the clean-up's worktree and branch; the branch stays as it is"
      >
        Cancel
      </ActionButton>
      <ActionButton
        class={`button${ready ? '' : ' secondary'}`}
        disabled={!ready}
        message={{ type: 'finishCleanUp' }}
        working="Finishing…"
        title={
          ready
            ? 'Keeps the old history, and moves the branch to the clean commits (asks first)'
            : 'Once the clean history ends at the same files, with nothing uncommitted'
        }
      >
        <i class="codicon codicon-check" /> Finish Clean-Up
      </ActionButton>
    </div>
  );
}

/**
 * Whether the ticket's work is merged into the base (read from git). A Done ticket with unmerged work warns, and offers
 * to merge it (a sibling ticket), dismiss it (superseded by another ticket) or open its branch.
 */
export function MergePanel({ ticket }: { ticket: TicketView }) {
  const merge = ticket.merge;
  const warn = unmergedWarning(ticket.item, merge);
  const unmerged = merge?.branches.filter((b) => b.state === 'unmerged') ?? [];
  const branch = unmerged[0]?.branch;
  const hasWorktree = !!branch && ticket.worktrees.some((w) => w.branch === branch);
  const label = merge && mergeLabel(merge);
  return (
    <div class={`review-panel ${warn ? 'waiting' : merge?.state === 'merged' ? 'done' : ''}`}>
      <i class={`codicon codicon-${warn ? 'warning' : 'git-merge'}`} />
      <span class="review-text">
        {label && <strong>{label[0].toUpperCase() + label.slice(1)}</strong>}
        {warn && ` It's Done, but this work isn't in ${merge!.base.replace(/^origin\//, '')} yet.`}
        {ticket.item.supersededBy && ` Superseded by ${ticket.item.supersededBy}.`}
      </span>
      {warn && (
        <>
          <ActionButton class="button secondary" message={{ type: 'mergeSibling' }} working="Adding…" title="Adds a ticket, next to this one, to merge the branch (asks which, when there are several)">
            <i class="codicon codicon-git-merge" /> Merge…
          </ActionButton>
          <ActionButton class="button secondary" message={{ type: 'dismissUnmerged' }} working="Dismissing…" title="The work is superseded by another ticket (asks which)">
            Dismiss
          </ActionButton>
          {hasWorktree ? (
            <button
              class="button secondary"
              onClick={() => send({ type: 'openWorktree', key: ticket.worktrees.find((w) => w.branch === branch)!.key })}
              title={`Opens ${branch}: its worktree`}
            >
              <i class="codicon codicon-git-branch" /> Open Branch
            </button>
          ) : (
            <ActionButton class="button secondary" message={{ type: 'checkout', branch: branch! }} working="Creating the worktree…" title={`Opens ${branch} in a new worktree`}>
              <i class="codicon codicon-git-branch" /> Open Branch
            </ActionButton>
          )}
        </>
      )}
    </div>
  );
}

/**
 * How the work stands against main (BL-55): its branches that conflict with main, and the tickets it waits for
 * ("Depends on: BL-12" in its description). Update from Main rebases its branch onto main (its agent resolves conflicts).
 */
export function MainState({ ticket }: { ticket: TicketView }) {
  const conflicts = conflictsOf(ticket.item);
  const waiting = ticket.dependsOn.filter((d) => d.status !== 'done');
  const update = ticket.updateFromMain;
  if (!conflicts.length && !waiting.length) return null;
  const label = (s: BacklogStatus) => STATUSES.find((x) => x.status === s)?.label ?? s;
  return (
    <>
      {conflicts.map((b) => (
        <div key={b.branch} class="error-note main-note">
          <i class="codicon codicon-git-merge" /> <code>{b.branch}</code> conflicts with {update?.base ?? 'main'} ({b.conflicts.join(', ')}).
          {update && (
            <UpdateFromButton
              class="text-button main-note-action"
              base={update.base}
              title={`Hands merging ${update.base} into the branch to its agent, which resolves the conflicts and runs the checks`}
            />
          )}
        </div>
      ))}
      {waiting.length > 0 && (
        <div class="error-note main-note">
          <i class="codicon codicon-debug-pause" /> Waits for{' '}
          {waiting.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <button class="text-button" onClick={() => send({ type: 'openTicket', id: d.id })} title={d.title}>
                {d.id}
              </button>{' '}
              ({label(d.status)})
            </span>
          ))}{' '}
          to be merged: it depends on {waiting.length === 1 ? 'its' : 'their'} work.
        </div>
      )}
    </>
  );
}
