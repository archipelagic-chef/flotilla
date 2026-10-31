import {
  useLayoutEffect,
  useRef,
} from 'preact/hooks';
import type {
  BacklogItemView,
  TicketVcView,
  WorkstreamView,
} from '../protocol';
import type { ChangedFile } from '../ticketProtocol';
import type { TicketCommit } from '../../features/history/log';
import { branchMatches } from '../../features/backlog/backlog';
import {
  menuContext,
  run,
  send,
} from './api';
import { vcFileContext } from '../vcFile';
import { CHANGE_LETTER } from './files';
import { fileIcon } from './icons';
import { ago } from './ago';
import type { CommitFiles } from './vc';
import './ticketVc.css';

/**
 * Version Control when a worktree is a ticket's (BL-171): a header leading back to the ticket, and two views of its
 * own: its Changes (every file it changes, as the ticket's Changes section lists them, in full) and its Commits (one at
 * a time, stepped through with Previous and Next).
 */

/** The ticket a worktree works on: the local item whose branch it's on. */
export function ticketOf(ws: WorkstreamView | undefined, backlog: BacklogItemView[] | undefined): BacklogItemView | undefined {
  if (!ws || ws.isMain || !ws.branch) return undefined;
  return backlog?.find((i) => !i.source && !i.proposed && branchMatches(i, ws.branch));
}

/** Above the worktree's header in every Version Control view: the ticket, and Back to it. */
export function TicketHeader({ item, path }: { item: Pick<BacklogItemView, 'id' | 'title'>; path?: string }) {
  return (
    <div class="ticket-vc-head">
      <button
        class="ticket-back"
        data-tip={`Back to ${item.id}, its Changes${path ? ` at ${path.split('/').pop()}` : ''}`}
        onClick={() => send({ type: 'backToTicket', id: item.id, ...(path ? { path } : {}) })}
      >
        <i class="codicon codicon-arrow-left" />
        Back to {item.id}
      </button>
      <span class="ticket-vc-title" data-tip={item.title} data-tip-if-cut>
        <span class="ticket-vc-id">{item.id}</span> {item.title}
      </span>
    </div>
  );
}

/** "+12 −3", or "binary". */
function Counts({ f }: { f: Pick<ChangedFile, 'added' | 'deleted' | 'binary'> }) {
  if (f.binary) return <span class="counts">binary</span>;
  return (
    <span class="counts">
      <span class="added">+{f.added}</span> <span class="deleted">−{f.deleted}</span>
    </span>
  );
}

/** The ticket's Changes in full: each comparison's files, with their line counts; the one Expand was on selected. */
export function TicketChangesBody({
  ws,
  view,
  selected,
  select,
}: {
  ws: WorkstreamView;
  view: TicketVcView | undefined;
  selected?: string;
  select(path: string): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selected) list.current?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected, !!view]);
  if (!view) return <div class="empty">Loading the ticket's changes…</div>;
  const { change } = view;
  if (!change.files) return <div class="empty">{view.id} changes no files yet.</div>;
  return (
    <div class="ticket-changes" ref={list}>
      <div class="row group-head">
        <span class="name" data-tip={change.stage}>
          {view.id}'s Changes
        </span>
        <span class="badge">{change.files}</span>
        <Counts f={change} />
      </div>
      {change.groups.map((g, group) => (
        <div key={`${g.dir}\n${g.label}`} role="group" aria-label={g.label}>
          {change.groups.length > 1 && (
            <div class="row group-head sub" data-tip={g.compared}>
              <span class="name">{g.label}</span>
              <span class="badge">{g.files.length}</span>
            </div>
          )}
          {g.files.map((f) => {
            const parts = f.path.split('/');
            const name = parts.pop()!;
            const diff = { type: 'openTicketChange', id: view.id, group, path: f.path } as const;
            const open = () => {
              select(f.path);
              send(diff);
            };
            return (
              <div
                key={f.path}
                class={`row change ticket-file${selected === f.path ? ' selected' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={selected === f.path ? 'true' : undefined}
                data-tip={f.uncommitted ? 'Changed and not committed yet' : undefined}
                data-vscode-context={menuContext('vcFile', vcFileContext(ws.key, f, diff, ws.context))}
                onClick={open}
                onKeyDown={(e) => e.key === 'Enter' && open()}
              >
                <i class={fileIcon(name)} />
                <span class={`name k-${f.kind}`}>{name}</span>
                <span class="dir">{parts.join('/')}</span>
                {f.uncommitted && <i class="codicon codicon-circle-filled uncommitted" aria-label="Not committed yet" />}
                <Counts f={f} />
                <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
                  <button class="icon" aria-label="Back to the Ticket" onClick={() => send({ type: 'backToTicket', id: view.id, path: f.path })}>
                    <i class="codicon codicon-arrow-left" />
                  </button>
                </span>
                <span class={`letter k-${f.kind}`}>{CHANGE_LETTER[f.kind]}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The ticket's commits, oldest first, one at a time: Previous and Next step through them; the list jumps. */
export function TicketCommitsBody({
  ws,
  view,
  selected,
  select,
  files,
  requestFiles,
}: {
  ws: WorkstreamView;
  view: TicketVcView | undefined;
  selected?: string;
  select(hash: string): void;
  files(hash: string): CommitFiles | undefined;
  requestFiles(key: string, hash: string): void;
}) {
  const commits: TicketCommit[] = view ? [...view.commits].reverse() : [];
  // The latest until one is picked.
  const picked = commits.findIndex((c) => c.hash === selected);
  const at = picked < 0 ? commits.length - 1 : picked;
  const commit = commits[at] as TicketCommit | undefined;
  const shown = commit && files(commit.hash);
  useLayoutEffect(() => {
    if (commit && !shown) requestFiles(ws.key, commit.hash);
  }, [ws.key, commit?.hash, !!shown]);
  if (!view) return <div class="empty">Loading the ticket's commits…</div>;
  if (!commit) return <div class="empty">{view.id} has no commits yet.</div>;
  const date = new Date(commit.date);
  return (
    <div class="ticket-commits">
      <div class="commit-step" role="toolbar" aria-label="Step through the commits">
        <button class="icon" aria-label="Previous Commit" disabled={at === 0} onClick={() => select(commits[at - 1].hash)}>
          <i class="codicon codicon-arrow-left" />
        </button>
        <span class="step-at">
          Commit {at + 1} of {commits.length}
        </span>
        <button class="icon" aria-label="Next Commit" disabled={at === commits.length - 1} onClick={() => select(commits[at + 1].hash)}>
          <i class="codicon codicon-arrow-right" />
        </button>
      </div>
      <div class="ticket-commit">
        <div class="ticket-commit-subject">{commit.subject}</div>
        <div class="commit-meta">
          <span>{commit.author}</span>
          <span data-tip={date.toLocaleString()}>{ago(commit.date)}</span>
          <button class="link" data-tip="Copy Commit Hash" onClick={() => send({ type: 'copy', text: commit.hash })}>
            {commit.short}
          </button>
          <button class="link" onClick={() => send({ type: 'openCommit', key: ws.key, hash: commit.hash })}>
            Open All Changes
          </button>
        </div>
      </div>
      {shown?.error && <div class="row group-empty error">{shown.error}</div>}
      {!shown?.error && !shown?.files.length && <div class="row group-empty">{!shown || shown.loading ? 'Loading…' : 'No file changes'}</div>}
      {shown?.files.map((change) => {
        const parts = change.path.split('/');
        const name = parts.pop()!;
        const diff = { type: 'openCommit', key: ws.key, hash: commit.hash, path: change.path } as const;
        const open = () => send(diff);
        return (
          <div
            key={change.path}
            class="row change commit-file"
            role="button"
            tabIndex={0}
            data-vscode-context={menuContext('vcFile', vcFileContext(ws.key, change, diff, ws.context))}
            onClick={open}
            onKeyDown={(e) => e.key === 'Enter' && open()}
          >
            <i class={fileIcon(name)} />
            <span class={`name k-${change.kind}`}>{name}</span>
            <span class="dir">{parts.join('/')}</span>
            <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
              {change.kind !== 'deleted' && (
                <button class="icon" aria-label="Open File" onClick={() => run('flotilla.openFile', { key: ws.key, path: change.path })}>
                  <i class="codicon codicon-go-to-file" />
                </button>
              )}
            </span>
            <span class={`letter k-${change.kind}`}>{CHANGE_LETTER[change.kind]}</span>
          </div>
        );
      })}
      <div class="row group-head">
        <span class="name">All Commits</span>
        <span class="badge">{commits.length}</span>
      </div>
      {commits.map((c, i) => (
        <div
          key={c.hash}
          class={`row ticket-commit-row${i === at ? ' selected' : ''}`}
          role="button"
          tabIndex={0}
          aria-current={i === at ? 'true' : undefined}
          onClick={() => select(c.hash)}
          onKeyDown={(e) => e.key === 'Enter' && select(c.hash)}
        >
          <span class="step-n">{i + 1}</span>
          <span class="name">{c.subject}</span>
          <span class="desc">{ago(c.date)}</span>
        </div>
      ))}
    </div>
  );
}
