import {
  fixesFor,
  fixLabel,
  heldBy,
  type ReviewFix,
} from '../../features/backlog/review';
import { STEP } from '../../features/backlog/nextSteps';
import { reviewOutcome } from '../../features/backlog/rounds';
import {
  TURN_ICON,
  TURN_LABEL,
  turnOf,
  turnSentence,
} from '../../features/backlog/turn';
import type { QueuedView, TicketCiView, TicketView } from '../ticketProtocol';
import { queuedNeed } from '../../features/backlog/needs';
import { ActionButton } from './actions';
import { PAUSE_TIP, RESUME_TIP, STOP_TIP } from './agents';
import { MergeStop, QueuePlace } from './mergePanel';
import { MergeStep, StepStatus, ticketSteps } from './steps';

const FIX_ICON: Record<ReviewFix, string> = {
  retry: 'debug-restart',
  newAgent: 'hubot',
  inChat: 'comment-discussion',
  anotherRound: 'refresh',
  worktree: 'git-branch',
  resumeNow: 'debug-continue',
  resume: 'debug-continue',
};

export const FIX_TIP: Record<ReviewFix, string> = {
  retry: 'Go on where it stopped',
  newAgent: 'Hand the request to a new agent, running without a window',
  inChat: "Opens the agent's chat with the request in its message box (and on the clipboard): send it there",
  anotherRound: 'Allow one more round of review and changes',
  worktree: 'Creates a worktree for it, then goes on',
  resumeNow: "Goes on now, without waiting for the limit's reset (if it hasn't reset, it pauses again)",
  resume: 'Goes on in its chat, where it left off (it checks git status first)',
};

/** A time as the status card says it: "Sun 14:02". */
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The ticket's discussion with its agent: its chat while it's open (BL-188), or the agent replying in the ticket
 * (BL-45), and when it says the ticket is ready.
 */
export function DiscussPanel({ ticket }: { ticket: TicketView }) {
  const s = ticket.shaping!;
  if ((s.chat === 'open' || s.chat === 'pending') && !s.ready) {
    return (
      <div class="review-panel working">
        <i class={`codicon codicon-comment-discussion${s.chat === 'open' ? ' pulse' : ''}`} />
        <span class="review-text">
          <strong>Discussing</strong>{' '}
          {s.chat === 'open'
            ? `with ${s.agent} in its chat: it writes what's agreed into the description as you go.`
            : `${s.agent}'s chat is ready: send its first message, and it starts.`}
        </span>
        <ActionButton class="button" message={{ type: 'discuss' }} working="Opening…" title="Open the discussion's chat in Claude Code">
          <i class="codicon codicon-comment-discussion" /> Open Chat
        </ActionButton>
      </div>
    );
  }
  if (s.held && !s.running) {
    return (
      <div class="review-panel waiting">
        <i class="codicon codicon-debug-pause" />
        <span class="review-text">
          <strong>Discussion</strong> You {s.held} {s.agent}. Its chat is kept: Resume, and it goes on there.
        </span>
        <ActionButton class="button" message={{ type: 'agent', action: 'resume' }} working="Resuming…" title={FIX_TIP.resume}>
          <i class="codicon codicon-debug-continue" /> Resume
        </ActionButton>
      </div>
    );
  }
  if (!s.running && !s.ready) return null;
  return (
    <div class={`review-panel ${s.running ? 'working' : 'done'}`}>
      <i class={`codicon codicon-comment-discussion${s.running ? ' pulse' : ''}`} />
      <span class="review-text">
        <strong>Discussion</strong> {s.running ? `${s.agent} is replying; its reply comes here.` : `${s.agent} says the ticket is ready to start.`}
      </span>
      {s.running && (
        <>
          <ActionButton class="button secondary" message={{ type: 'agent', action: 'pause' }} working="Pausing…" title={PAUSE_TIP}>
            <i class="codicon codicon-debug-pause" /> Pause
          </ActionButton>
          <ActionButton class="button secondary" message={{ type: 'agent', action: 'stop' }} working="Stopping…" title={STOP_TIP}>
            <i class="codicon codicon-debug-stop" /> Stop
          </ActionButton>
        </>
      )}
      {s.ready && !s.running && (
        <>
          {ticket.item.proposed ? (
            <ActionButton class="button" message={{ type: 'accept' }} working="Accepting…">
              <i class="codicon codicon-check" /> Accept
            </ActionButton>
          ) : (
            <ActionButton class="button" message={{ type: 'start', agent: true }} working="Starting…">
              <i class="codicon codicon-play" /> Start
            </ActionButton>
          )}
          <ActionButton class="button secondary" message={{ type: 'keepDiscussing' }} working="Continuing…" title="Dismisses this; Discuss goes on with it">
            Keep discussing
          </ActionButton>
        </>
      )}
    </div>
  );
}

/** A start that waits for a free agent slot or for free memory, with Prioritize (it starts now, above the limit). */
export function QueuedPanel({ queued }: { queued: QueuedView }) {
  return (
    <div class="review-panel waiting">
      <i class="codicon codicon-clock" />
      <span class="review-text">
        {queuedNeed(queued).line}
        {queued.reason === 'slot' ? `: ${queued.running} of ${queued.limit} agents running.` : '.'}
      </span>
      <ActionButton
        class="button secondary"
        message={{ type: 'prioritize' }}
        working="Starting…"
        title="Starts it now, above the limit, or pauses a running agent to make room"
      >
        <i class="codicon codicon-arrow-up" /> Prioritize
      </ActionButton>
    </div>
  );
}

/** Where the review loop is: who reviews, the verdict; stop it, or start it again. */
export function ReviewPanel({ ticket, ci }: { ticket: TicketView; ci?: TicketCiView }) {
  const r = ticket.review!;
  const steps = ticketSteps(ticket, ci);
  const active = r.state === 'reviewing' || r.state === 'revising' || r.state === 'asking' || r.state === 'working' || r.state === 'paused';
  // Whose turn it is, said in words with the reviewer and the implementer named, and what the user can do now.
  // A review start waiting in the agents' queue makes it the reviewer agent's turn (BL-212).
  const turn = turnOf({ status: ticket.item.status, review: r, ...(ticket.queued ? { queued: ticket.queued } : {}) });
  // Its agent stopped without a question (BL-198): it's resumed, not answered.
  const resume = steps.main === 'resume';
  const said =
    turn && resume
      ? {
          text: `${r.implementer ?? 'The agent'} stopped, to go on later.`,
          todo: 'Resume it: it goes on in its chat, where it left off. Start an Agent starts afresh instead.',
        }
      : turn && turnSentence(turn, r);
  const pause =
    r.state === 'paused' && r.paused?.byUser
      ? `(${when(r.paused.byUser)}) Its chat is kept, and its work in the worktree as it was.`
      : r.state === 'paused' && r.paused?.for
        ? `${r.paused.agent} is paused for ${r.paused.for}: its slot went to a prioritized start. It resumes from its chat when a slot frees.`
        : r.state === 'paused' && r.paused
          ? `${r.paused.agent} stopped on ${r.paused.kind === 'rate' ? "Claude's rate limit" : r.paused.kind === 'overloaded' ? 'Claude being overloaded' : "Claude's usage limit"}; it goes on by itself ${r.paused.known ? 'when it resets' : 'at'} ${when(r.paused.until)}.`
          : r.state === 'stopped' && r.stop?.kind === 'user' && r.stop.at
            ? `(${when(r.stop.at)})`
            : undefined;
  // The agent the user paused or stopped: it can be resumed in its chat.
  const held = heldBy(r);
  const running = r.state === 'reviewing' || r.state === 'revising' || r.state === 'working';
  const autopilot = (r.state === 'working' && !turn?.queued) || (r.state === 'paused' && r.paused?.phase === 'work' && (r.autopilot || r.byHand) && !turn);
  const [icon, cls, label, text, todo] = autopilot
    ? r.byHand
      ? [
          'play',
          'working',
          'Working',
          pause ?? `${r.implementer ?? 'the implementer'} is working on it (you started it, without a window); it reports below`,
          undefined,
        ]
      : [
          'rocket',
          'working',
          'Autopilot',
          pause ?? `${r.implementer ?? 'the implementer'} is working on it (the autopilot started it); it reports below`,
          undefined,
        ]
    : turn && said
      ? [
          r.state === 'paused' ? 'debug-pause' : TURN_ICON[turn.kind],
          turn.kind === 'stopped' ? 'stopped' : r.state === 'approved' && r.byUser ? 'done' : turn.mine ? 'waiting' : 'working',
          TURN_LABEL[turn.kind],
          pause ? `${said.text} ${pause}` : said.text,
          said.todo,
        ]
      : r.state === 'approved'
        ? ['pass-filled', 'done', 'Approved', `by ${r.byUser ? 'you' : r.reviewer}.`, undefined]
        : ['circle-large-outline', 'idle', capitalized(reviewOutcome(r.state)), pause ?? '', undefined];
  // A reviewer agent's approval waits for the user's: they approve it too, or ask for changes.
  const yours = r.state === 'yours' || (r.state === 'approved' && !r.byUser);
  return (
    <>
      <div class={`review-panel ${cls}`}>
        <i class={`codicon codicon-${icon}${r.running ? ' pulse' : ''}`} />
        <span class="review-text">
          <strong>{label}</strong> {text}
          {todo && <span class="muted review-todo"> {todo}</span>}
          <StepStatus steps={steps} />
        </span>
        {r.state === 'paused' &&
          (r.paused?.byUser ? (
            <ActionButton class="button" message={{ type: 'agent', action: 'resume' }} working="Resuming…" title={FIX_TIP.resume}>
              <i class={`codicon codicon-${FIX_ICON.resume}`} /> {fixLabel('resume', undefined)}
            </ActionButton>
          ) : (
            <ActionButton class="button secondary" message={{ type: 'reviewFix', fix: 'resumeNow' }} working="Going on…" title={FIX_TIP.resumeNow}>
              <i class={`codicon codicon-${FIX_ICON.resumeNow}`} /> {fixLabel('resumeNow', undefined)}
            </ActionButton>
          ))}
        {running && !yours && !turn?.queued && (
          <ActionButton class="button secondary" message={{ type: 'agent', action: 'pause' }} working="Pausing…" title={PAUSE_TIP}>
            <i class="codicon codicon-debug-pause" /> Pause
          </ActionButton>
        )}
        {yours ? (
          <>
            <button
              class="button secondary"
              onClick={() => {
                // What should change is written in the comment box: Request Changes sends it.
                const box = document.querySelector<HTMLTextAreaElement>('.comment-box textarea');
                box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                box?.focus();
              }}
              title="Write what should change below, then Request Changes"
            >
              <i class="codicon codicon-request-changes" /> Request Changes…
            </button>
            <ActionButton class="button" message={{ type: 'userReview', verdict: 'approved', text: '' }} working="Sending…">
              <i class="codicon codicon-check" /> Approve
            </ActionButton>
          </>
        ) : active ? (
          <>
            {resume && (
              <ActionButton class="button" message={{ type: 'agent', action: 'resume' }} working="Resuming…" title={RESUME_TIP}>
                <i class={`codicon codicon-${STEP.resume.icon}`} /> {STEP.resume.label}
              </ActionButton>
            )}
            {/* While a reviewer agent works, its Stop is Review It Myself: Approve and Request Changes come back with it (BL-154). */}
            {steps.others.includes('reviewMyself') ? (
              <ActionButton
                class="button secondary"
                message={{ type: 'stopReview' }}
                working="Stopping…"
                title="Stops the reviewer agent: Approve and Request Changes are yours, below"
              >
                <i class="codicon codicon-eye" /> Review It Myself
              </ActionButton>
            ) : (
              <ActionButton
                class="button secondary"
                message={{ type: 'stopReview' }}
                working="Stopping…"
                title={running ? STOP_TIP : 'Stops the review and the handoffs'}
              >
                <i class="codicon codicon-debug-stop" /> Stop
              </ActionButton>
            )}
          </>
        ) : r.state === 'stopped' ? (
          // Fixes for why it stopped, the first one first.
          fixesFor(r.stop?.kind, !!r.stop?.task, held).map((fix, i) => (
            <ActionButton key={fix} class={`button${i ? ' secondary' : ''}`} message={{ type: 'reviewFix', fix }} working="Going on…" title={FIX_TIP[fix]}>
              <i class={`codicon codicon-${FIX_ICON[fix]}`} /> {fixLabel(fix, r.stop?.kind)}
            </ActionButton>
          ))
        ) : (
          <>
            {ticket.canReview && (
              <ActionButton class="button secondary" message={{ type: 'startReview' }} working="Starting the review…">
                <i class="codicon codicon-eye" /> Review Again
              </ActionButton>
            )}
            {ticket.canMerge && <MergeStep ticket={ticket} ci={ci} steps={steps} />}
          </>
        )}
      </div>
      {ticket.canMerge && ticket.mergeStop && !active && <MergeStop stop={ticket.mergeStop} />}
      {ticket.canMerge && ticket.mergeQueue && !active && <QueuePlace queue={ticket.mergeQueue} />}
    </>
  );
}
