import { useState } from 'preact/hooks';
import {
  holdsUpLine,
  type Need,
  type NeedKind,
  needsYouRows,
} from '../../features/backlog/needs';
import { fixesFor, fixLabel } from '../../features/backlog/review';
import type { BacklogItemView as BacklogItem, NoteView } from '../protocol';
import { send } from './api';
import { BusyButton } from './backlogBusy';
import { answerNote } from './notes';
import './needsYou.css';

function waited(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

const NEED_ICON: Record<NeedKind, string> = {
  asking: 'comment-discussion',
  yours: 'eye',
  approved: 'pass-filled',
  merge: 'git-merge',
  stopped: 'debug-pause',
  failed: 'error',
  queued: 'clock',
};
const NEED_TITLE: Record<NeedKind, string> = {
  asking: 'Has a question for you',
  yours: 'Ready for your review',
  approved: 'Approved, not merged yet',
  merge: 'Its merge needs you',
  stopped: 'Its review stopped',
  failed: "The autopilot couldn't start it",
  queued: 'Your reply waits for a free agent',
};

/**
 * What waits on the user, across the backlog, oldest first: an agent's question (on a ticket or a note), work ready
 * for review, approved work, a stopped review, a start that failed. Each row has the actions for it; folded away when
 * there's nothing.
 */
export function NeedsYou({ items, notes = [] }: { items: BacklogItem[]; notes?: NoteView[] }) {
  const [open, setOpen] = useState(true);
  const rows = needsYouRows(items, notes);
  const signIn = signInNeed(items);
  if (!rows.length && !signIn) return null;
  return (
    <div class="group lane needs-lane">
      <div class="row group-head" onClick={() => setOpen(!open)}>
        <span class="name">Needs you</span>
        <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} lane-chev`} aria-label={open ? 'Hide what needs you' : 'Show what needs you'} />
        <span class="badge">{rows.length + (signIn ? 1 : 0)}</span>
      </div>
      {open && (
        <div class="lane-body">
          {signIn && <SignInRow need={signIn} />}
          {rows.map((row) => (row.note ? <NoteNeedRow key={row.note.id} note={row.note} need={row.need!} /> : <NeedRow key={row.item.id} item={row.item} />))}
        </div>
      )}
    </div>
  );
}

/** Tickets in review whose pull requests wait for you to sign in to GitHub (BL-232): one row for them all. */
function signInNeed(items: BacklogItem[]): { since: string; count: number } | undefined {
  const waiting = items.filter(
    (i) => i.pullRequestSignIn && i.status === 'review' && !i.merged && !i.discarded && !i.pullRequests?.some((p) => p.state === 'open'),
  );
  if (!waiting.length) return undefined;
  return { since: waiting.map((i) => i.pullRequestSignIn!).sort()[0], count: waiting.length };
}

/** Pull requests on GitHub need you to sign in: Sign In asks for the session, and they're opened then. */
function SignInRow({ need }: { need: { since: string; count: number } }) {
  const age = waited(need.since);
  return (
    <div class="row backlog-item need need-signIn" title="Flotilla opens the pull requests once you sign in to GitHub in VS Code">
      <i class="codicon codicon-github need-icon" />
      <span class="name">Pull requests on GitHub need you to sign in</span>
      <span class="need-line">{need.count === 1 ? '1 ticket waits for its pull request' : `${need.count} tickets wait for their pull requests`}</span>
      {age && <span class="need-age">{age}</span>}
      <span class="need-actions">
        <button class="button" onClick={() => send({ type: 'ci', op: 'signIn' })}>
          Sign In
        </button>
      </span>
    </div>
  );
}

/** A note whose agent asks: Answer goes to its card in the Notes lane, where its questions are; Open opens the note. */
function NoteNeedRow({ note, need }: { note: NoteView; need: Need }) {
  const age = waited(need.since);
  const open = () => send({ type: 'note', op: 'open', id: note.id });
  return (
    <div
      class={`row backlog-item need need-${need.kind} need-note`}
      tabIndex={0}
      title="Its agent has a question for you"
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      }}
    >
      <i class={`codicon codicon-${NEED_ICON[need.kind]} need-icon`} />
      <span class="item-id">{note.id}</span>
      <span class="name">{note.title}</span>
      <span class="need-line">{need.line}</span>
      {age && <span class="need-age">{age}</span>}
      <span class="need-actions" onClick={(e) => e.stopPropagation()}>
        <button class="button" onClick={() => answerNote(note.id)} title="Opens the note's tab at its agent's questions: answer there">
          <i class="codicon codicon-comment" /> Answer
        </button>
        <button class="button secondary" onClick={open}>
          Open
        </button>
      </span>
    </div>
  );
}

function NeedRow({ item }: { item: BacklogItem }) {
  const need = item.need!;
  const r = item.review;
  const age = waited(need.since);
  const open = () => send({ type: 'backlog', op: 'open', id: item.id });
  // The actions of the ticket, here: the first fix of a stopped review is the one to offer first.
  const fix = r?.state === 'stopped' ? fixesFor(r.stop?.kind, !!r.stop?.task)[0] : undefined;
  return (
    <div
      class={`row backlog-item need need-${need.kind}`}
      tabIndex={0}
      title={NEED_TITLE[need.kind]}
      onClick={open}
      onKeyDown={(e) => {
        // Enter on one of the row's buttons is theirs: only the row itself opens the ticket.
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      }}
    >
      <i class={`codicon codicon-${NEED_ICON[need.kind]} need-icon`} />
      <span class="item-id">{item.id}</span>
      <span class="name">{item.title}</span>
      <span class="need-line">{need.line}</span>
      {item.holdsUp?.length ? <HoldsUp ids={item.holdsUp} /> : null}
      {age && <span class="need-age">{age}</span>}
      <span class="need-actions" onClick={(e) => e.stopPropagation()}>
        {need.kind === 'asking' && (
          <button
            class="button"
            onClick={() => send({ type: 'backlog', op: 'comment', id: item.id })}
            title="Opens the ticket with the comment box focused: answer there"
          >
            <i class="codicon codicon-comment" /> Answer
          </button>
        )}
        {need.kind === 'yours' && (
          <>
            <button
              class="button secondary"
              onClick={() => send({ type: 'backlog', op: 'comment', id: item.id })}
              title="Opens the ticket with the comment box focused: write what should change"
            >
              <i class="codicon codicon-request-changes" /> Request Changes
            </button>
            <BusyButton class="button" message={{ type: 'backlog', op: 'approve', id: item.id }} icon="check">
              {' '}
              Approve
            </BusyButton>
          </>
        )}
        {need.kind === 'stopped' && fix && (
          <BusyButton class="button" message={{ type: 'backlog', op: 'fix', id: item.id, fix }}>
            {fixLabel(fix, r?.stop?.kind)}
          </BusyButton>
        )}
        {need.kind === 'queued' && (
          <BusyButton
            class="button"
            message={{ type: 'backlog', op: 'prioritize', id: item.id }}
            icon="arrow-up"
            title="Starts it now, above the limit, or pauses a running agent to make room"
          >
            {' '}
            Prioritize
          </BusyButton>
        )}
        {need.kind === 'failed' && (
          <BusyButton
            class="button"
            message={{ type: 'backlog', op: 'start', id: item.id }}
            icon="play"
            title="Creates its worktree if needed and starts an agent there: it runs in the background and reports in the ticket"
          >
            {' '}
            Run
          </BusyButton>
        )}
        <button class="button secondary" onClick={open}>
          Open
        </button>
      </span>
    </div>
  );
}

/**
 * The tickets a row holds up (BL-238): they wait for it to be merged, directly or through a chain. The hover lists
 * them; each id opens its ticket.
 */
function HoldsUp({ ids }: { ids: readonly string[] }) {
  const link = (id: string) => (
    <a key={id} class="need-holds-id" onClick={() => send({ type: 'backlog', op: 'open', id })}>
      {id}
    </a>
  );
  return (
    <span class="need-holds" data-tip={`${ids.join(', ')} ${ids.length === 1 ? 'waits' : 'wait'} for it to be merged`} onClick={(e) => e.stopPropagation()}>
      <i class="codicon codicon-debug-step-over" />
      {ids.length === 1 ? (
        <>holds up {link(ids[0])}</>
      ) : (
        <>
          {holdsUpLine(ids)} ({ids.map((id, n) => [n > 0 && ', ', link(id)])})
        </>
      )}
    </span>
  );
}
