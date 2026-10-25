import { useState } from 'preact/hooks';
import { type NeedKind, oldestFirst } from '../../features/backlog/needs';
import { fixesFor, fixLabel } from '../../features/backlog/review';
import type { BacklogItemView as BacklogItem } from '../protocol';
import { send } from './api';
import { BusyButton } from './backlogBusy';
import './needsYou.css';

function waited(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

const NEED_ICON: Record<NeedKind, string> = { asking: 'comment-discussion', yours: 'eye', approved: 'pass-filled', stopped: 'debug-pause', failed: 'error', queued: 'clock' };
const NEED_TITLE: Record<NeedKind, string> = {
  asking: 'Has a question for you',
  yours: 'Ready for your review',
  approved: 'Approved, not merged yet',
  stopped: 'Its review stopped',
  failed: "The autopilot couldn't start it",
  queued: 'Your reply waits for a free agent',
};

/**
 * What waits on the user, across the backlog, oldest first: an agent's question, work ready for review, approved
 * work, a stopped review, a start that failed. Each row has the actions for it; folded away when there's nothing.
 */
export function NeedsYou({ items }: { items: BacklogItem[] }) {
  const [open, setOpen] = useState(true);
  const rows = oldestFirst(items);
  if (!rows.length) return null;
  return (
    <div class="group lane needs-lane">
      <div class="row group-head" onClick={() => setOpen(!open)}>
        <span class="name">Needs you</span>
        <i class={`codicon codicon-chevron-${open ? 'down' : 'right'} lane-chev`} aria-label={open ? 'Hide what needs you' : 'Show what needs you'} />
        <span class="badge">{rows.length}</span>
      </div>
      {open && (
        <div class="lane-body">
          {rows.map((item) => (
            <NeedRow key={item.id} item={item} />
          ))}
        </div>
      )}
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
      {age && <span class="need-age">{age}</span>}
      <span class="need-actions" onClick={(e) => e.stopPropagation()}>
        {need.kind === 'asking' && (
          <button class="button" onClick={() => send({ type: 'backlog', op: 'comment', id: item.id })} title="Opens the ticket with the comment box focused: answer there">
            <i class="codicon codicon-comment" /> Answer
          </button>
        )}
        {need.kind === 'yours' && (
          <>
            <button class="button secondary" onClick={() => send({ type: 'backlog', op: 'comment', id: item.id })} title="Opens the ticket with the comment box focused: write what should change">
              <i class="codicon codicon-request-changes" /> Request Changes
            </button>
            <BusyButton class="button" message={{ type: 'backlog', op: 'approve', id: item.id }} icon="check">
              {' '}Approve
            </BusyButton>
          </>
        )}
        {need.kind === 'stopped' && fix && (
          <BusyButton class="button" message={{ type: 'backlog', op: 'fix', id: item.id, fix }}>
            {fixLabel(fix, r?.stop?.kind)}
          </BusyButton>
        )}
        {need.kind === 'queued' && (
          <BusyButton class="button" message={{ type: 'backlog', op: 'prioritize', id: item.id }} icon="arrow-up" title="Starts it now, above the limit, or pauses a running agent to make room">
            {' '}Prioritize
          </BusyButton>
        )}
        {need.kind === 'failed' && (
          <BusyButton class="button" message={{ type: 'backlog', op: 'start', id: item.id }} icon="play" title="Creates its worktree if needed and starts an agent there: it runs in the background and reports in the ticket">
            {' '}Run
          </BusyButton>
        )}
        <button class="button secondary" onClick={open}>
          Open
        </button>
      </span>
    </div>
  );
}
