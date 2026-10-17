import { Component, render, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { AGENT_EFFORTS, entryAgent, priorityFromName, type BacklogStatus } from '../../features/backlog/backlog';
import { mergeLabel, unmergedWarning } from '../../features/backlog/merged';
import { fixesFor, fixLabel, type ReviewFix } from '../../features/backlog/review';
import type { AgentChatView, TicketHostMessage, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { PRIORITY, PriorityPicker } from '../ui/priority';
import '../ui/priority.css';
import './ticket.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const send = (message: TicketWebviewMessage) => vscode.postMessage(message);

const STATUSES: Array<{ status: BacklogStatus; label: string; icon: string }> = [
  { status: 'todo', label: 'To Do', icon: 'circle-large-outline' },
  { status: 'doing', label: 'In Progress', icon: 'circle-large-filled' },
  { status: 'review', label: 'In Review', icon: 'eye' },
  { status: 'done', label: 'Done', icon: 'pass-filled' },
];

/** Replies to pasted or dropped images, by request id. */
const imageReplies = new Map<number, (markdown: string) => void>();
let nextImage = 1;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Saves the images among files next to the ticket and inserts links to them at the textarea's cursor. */
async function attachImages(files: FileList | File[], area: HTMLTextAreaElement, setText: (text: string) => void): Promise<boolean> {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    const requestId = nextImage++;
    const markdown = await new Promise<string>((resolve) => {
      imageReplies.set(requestId, resolve);
      void readAsBase64(file).then((data) =>
        send({
          type: 'image',
          requestId,
          name: file.name || 'pasted.png',
          data,
        }),
      );
    });
    const at = area.selectionStart ?? area.value.length;
    const before = area.value.slice(0, at);
    const text = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${markdown}\n${area.value.slice(at)}`;
    setText(text);
  }
  return images.length > 0;
}

/** A Markdown box that grows with its text and takes pasted or dropped images. */
function MarkdownBox({
  value,
  setValue,
  placeholder,
  label,
  onSubmit,
  autoFocus,
  minRows = 3,
  images = true,
}: {
  value: string;
  setValue(text: string): void;
  placeholder: string;
  label: string;
  onSubmit(): void;
  autoFocus?: boolean;
  minRows?: number;
  /** Pasted and dropped images are saved next to the ticket (not for issues that live in a tracker). */
  images?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);
  return (
    <textarea
      ref={area}
      class="md-box"
      rows={minRows}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
      onPaste={(e) => {
        const files = e.clipboardData?.files;
        if (images && files?.length && [...files].some((f) => f.type.startsWith('image/'))) {
          e.preventDefault();
          void attachImages(files, area.current!, setValue);
        }
      }}
      onDragOver={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        const files = e.dataTransfer?.files;
        if (images && files?.length) {
          e.preventDefault();
          void attachImages(files, area.current!, setValue);
        }
      }}
    />
  );
}

/** Rendered Markdown from the host (VS Code's renderer; scripts are blocked by the page's policy). */
function Rendered({ html, empty }: { html: string; empty: string }) {
  if (!html) return <div class="rendered empty-text">{empty}</div>;
  // Links open here (files at their lines, in the ticket's worktree) or in the browser: not inside the view.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    send({ type: 'openHref', href });
  };
  return <div class="rendered" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Title({ ticket }: { ticket: TicketView }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(ticket.item.title);
  useEffect(() => setTitle(ticket.item.title), [ticket.item.title]);
  const save = () => {
    setEditing(false);
    if (title.trim() && title.trim() !== ticket.item.title) send({ type: 'title', title });
    else setTitle(ticket.item.title);
  };
  if (ticket.remote && !ticket.remote.edit?.canEditTitle) return <h1 class="title readonly">{ticket.item.title}</h1>;
  if (editing) {
    return (
      <input
        class="title-input"
        value={title}
        aria-label="Title"
        ref={(el) => el?.focus()}
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') {
            setTitle(ticket.item.title);
            setEditing(false);
          }
        }}
        onBlur={save}
      />
    );
  }
  return (
    <h1 class="title" title={ticket.remote ? `Click to edit (in ${ticket.remote.label})` : 'Click to edit'} onClick={() => setEditing(true)}>
      {ticket.item.title}
    </h1>
  );
}

function Description({ ticket }: { ticket: TicketView }) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const editable = !ticket.remote || !!ticket.remote.edit?.canEditDescription;
  const jira = ticket.remote?.kind === 'jira';
  const save = () => {
    if (draft !== undefined && draft !== ticket.description) send({ type: 'description', text: draft });
    setDraft(undefined);
  };
  return (
    <section class="block">
      <div class="block-head">
        <h2>Description</h2>
        <span class="head-actions">
          {draft === undefined && editable && !ticket.loading && (
            <button class="text-button" onClick={() => setDraft(ticket.description)}>
              <i class="codicon codicon-edit" /> Edit
            </button>
          )}
          {ticket.remote && (
            <button class="text-button" onClick={() => send({ type: 'openRemote' })}>
              <i class="codicon codicon-link-external" /> Open in {jira ? 'Jira' : 'GitHub'}
            </button>
          )}
        </span>
      </div>
      {ticket.loading ? (
        <div class="rendered empty-text">Loading from {ticket.remote?.label ?? 'its tracker'}…</div>
      ) : draft === undefined ? (
        <div onDblClick={() => editable && setDraft(ticket.description)}>
          <Rendered html={ticket.descriptionHtml} empty={ticket.remote ? 'No description.' : 'No description yet. Edit it, or have Claude write it.'} />
        </div>
      ) : (
        <>
          <MarkdownBox
            value={draft}
            setValue={setDraft}
            placeholder={
              jira
                ? 'In Jira formatting (h2. Heading, *bold*, * list). Ctrl+Enter saves it in Jira.'
                : ticket.remote
                  ? 'Markdown. Ctrl+Enter saves it in GitHub.'
                  : 'What and why, in Markdown. Paste or drop images. Ctrl+Enter saves.'
            }
            label="Description"
            onSubmit={save}
            autoFocus
            minRows={8}
            images={!ticket.remote}
          />
          {jira && <div class="hint">Jira's own formatting: this is the description as Jira stores it.</div>}
          <div class="actions-row">
            <button class="button" onClick={save}>
              Save
            </button>
            <button class="button secondary" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const CHAT_STATE: Record<string, { label: string; cls: string }> = {
  working: { label: 'Working', cls: 'working' },
  'waiting-for-input': { label: 'Waiting for you', cls: 'waiting' },
  done: { label: 'Done', cls: 'done' },
  ended: { label: 'Ended', cls: 'ended' },
};

/** "5 min ago", "3 h ago", "2 d ago". */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** An agent's chat, linked from the entry that started it: click to open it in Claude Code. */
function ChatCard({ chat }: { chat: AgentChatView }) {
  if ('pending' in chat) {
    return (
      <div class="chat-card pending">
        <span class="chat-icon">
          <i class="codicon codicon-comment-discussion" />
        </span>
        <span class="chat-text">
          <span class="chat-title">{chat.headless ? `${chat.agent} is running without a window` : `${chat.agent}: waiting for its chat to start`}</span>
          <span class="muted">
            {chat.headless
              ? 'Its chat shows here once Flotilla sees it (with chat hooks installed in the worktree).'
              : "Send the message waiting in Claude Code's chat; the chat shows here then."}
          </span>
        </span>
      </div>
    );
  }
  const state = CHAT_STATE[chat.state] ?? CHAT_STATE.ended;
  return (
    <button class={`chat-card ${state.cls}`} onClick={() => send({ type: 'openChat', key: chat.key, id: chat.id })} title="Open this chat in Claude Code">
      <span class="chat-icon">
        <i class="codicon codicon-comment-discussion" />
        <span class={`dot ${state.cls}`} />
      </span>
      <span class="chat-text">
        <span class="chat-title">
          {chat.agent} <span class="chat-subtitle">· {chat.title}</span>
        </span>
        <span class="chat-meta">
          <span class={`state ${state.cls}`}>{state.label}</span>
          <span class="muted">
            <i class="codicon codicon-git-branch" /> {chat.branch} · {ago(chat.updated)}
          </span>
        </span>
        {chat.message && <span class="chat-message">“{chat.message}”</span>}
      </span>
      <span class="chat-open">
        Open Chat <i class="codicon codicon-arrow-right" />
      </span>
    </button>
  );
}

const AUTHOR_ICON: Record<string, string> = {
  you: 'account',
  agent: 'hubot',
  flotilla: 'info',
};

const FIX_ICON: Record<ReviewFix, string> = {
  retry: 'debug-restart',
  newAgent: 'hubot',
  inChat: 'comment-discussion',
  anotherRound: 'refresh',
  worktree: 'git-branch',
  resumeNow: 'debug-continue',
};

const FIX_TIP: Record<ReviewFix, string> = {
  retry: 'Go on where it stopped',
  newAgent: 'Hand the request to a new agent, running without a window',
  inChat: "Opens the agent's chat with the request in its message box (and on the clipboard): send it there",
  anotherRound: 'Allow one more round of review and changes',
  worktree: 'Creates a worktree for it, then goes on',
  resumeNow: "Goes on now, without waiting for the limit's reset (if it hasn't reset, it pauses again)",
};

/** Where the review loop is: who reviews, the round, the verdict; stop it, or start it again. */
function ReviewPanel({ ticket }: { ticket: TicketView }) {
  const r = ticket.review!;
  const active = r.state === 'reviewing' || r.state === 'revising' || r.state === 'asking' || r.state === 'working' || r.state === 'paused';
  const who = r.implementer ?? 'the implementer';
  const [icon, cls, text] =
    r.state === 'working'
      ? ['rocket', 'working', `${who} is working on it (the autopilot started it); it reports below`]
      : r.state === 'paused' && r.paused
        ? [
            'debug-pause',
            'waiting',
            `${r.paused.agent} stopped on Claude's usage limit; it goes on by itself ${r.paused.known ? 'when it resets' : 'at'} ${new Date(r.paused.until).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`,
          ]
        : r.state === 'reviewing'
          ? ['eye', 'working', `${r.reviewer} is reviewing${r.implementer ? ` ${r.implementer}'s work` : ''}`]
          : r.state === 'revising'
            ? ['tools', 'waiting', `${r.byUser ? 'You' : r.reviewer} requested changes; ${who} is ${r.running ? 'making them' : 'on it'}`]
            : r.state === 'asking'
              ? ['question', 'waiting', `${who} has a question for you. Answer it in a comment below; it goes on from there.`]
              : r.state === 'yours'
                ? ['eye', 'waiting', `${who} made the changes you asked for. It's ready for your review.`]
                : r.state === 'approved'
                  ? ['pass-filled', 'done', `Approved by ${r.byUser ? 'you' : r.reviewer}. Ready to merge.`]
                  : ['debug-pause', 'stopped', `Review stopped: ${r.reason ?? 'no verdict.'}`];
  return (
    <div class={`review-panel ${cls}`}>
      <i class={`codicon codicon-${icon}${r.running ? ' pulse' : ''}`} />
      <span class="review-text">
        <strong>
          {r.state === 'working' || (r.state === 'paused' && r.paused?.phase === 'work' && r.autopilot)
            ? 'Autopilot'
            : `Review${r.round ? ` · round ${r.round}` : ''}`}
        </strong>{' '}
        {text}
      </span>
      {r.state === 'paused' && (
        <button class="button secondary" onClick={() => send({ type: 'reviewFix', fix: 'resumeNow' })} title={FIX_TIP.resumeNow}>
          <i class={`codicon codicon-${FIX_ICON.resumeNow}`} /> {fixLabel('resumeNow', undefined)}
        </button>
      )}
      {r.state === 'yours' ? (
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
          <button class="button" onClick={() => send({ type: 'userReview', verdict: 'approved', text: '' })}>
            <i class="codicon codicon-check" /> Approve
          </button>
        </>
      ) : active ? (
        <button class="button secondary" onClick={() => send({ type: 'stopReview' })} title="Stops the running agent and the handoffs">
          <i class="codicon codicon-debug-stop" /> Stop
        </button>
      ) : r.state === 'stopped' ? (
        // Fixes for why it stopped, the first one first.
        fixesFor(r.stop?.kind, !!r.stop?.task).map((fix, i) => (
          <button key={fix} class={`button${i ? ' secondary' : ''}`} onClick={() => send({ type: 'reviewFix', fix })} title={FIX_TIP[fix]}>
            <i class={`codicon codicon-${FIX_ICON[fix]}`} /> {fixLabel(fix, r.stop?.kind)}
          </button>
        ))
      ) : (
        ticket.canReview && (
          <button class="button secondary" onClick={() => send({ type: 'startReview' })}>
            <i class="codicon codicon-eye" /> Review Again
          </button>
        )
      )}
    </div>
  );
}

/** The ticket's parts (sub-tickets), with how far along they are. */
function Parts({ ticket }: { ticket: TicketView }) {
  const done = ticket.children.filter((c) => c.status === 'done').length;
  return (
    <section class="block">
      <div class="block-head">
        <h2>
          Parts{' '}
          <span class="muted parts-progress">
            {done} of {ticket.children.length} done
          </span>
        </h2>
      </div>
      <div class="work">
        {ticket.children.map((c) => (
          <button
            key={c.id}
            class={`work-row${c.status === 'done' ? ' dim' : ''}`}
            onClick={() => send({ type: 'openTicket', id: c.id })}
            title="Open its ticket"
          >
            <i class={`codicon codicon-${c.proposed ? 'lightbulb' : LANE_ICON[c.status]}`} />
            <span class="hash">{c.id}</span>
            <span class="work-main subject">{c.title}</span>
            {c.proposed && <span class="branch-tag mention">proposed</span>}
            {c.priority && <i class={`codicon codicon-${PRIORITY[c.priority].icon} prio-${c.priority}`} />}
            <i class="codicon codicon-arrow-right open-arrow" />
          </button>
        ))}
      </div>
    </section>
  );
}

const COMMITS_SHOWN = 8;

/** A history kept from a clean-up: what it was, and (opened) its commits. */
function HistoryVersionRow({ version: v }: { version: TicketView['history'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button class="work-row" onClick={() => setOpen(!open)} aria-expanded={open} title={`Kept as ${v.ref}: not a branch, and not pushed`}>
        <i class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
        <span class="work-main">
          v{v.version} <span class="muted">{v.branch}</span>
        </span>
        <span class="muted">
          {v.commits} commit{v.commits === 1 ? '' : 's'}, cleaned up into {v.cleanCommits} · {ago(v.archived)}
        </span>
      </button>
      {open &&
        v.log.map((c) => (
          <button
            key={c.hash}
            class="work-row commit nested"
            onClick={() => send({ type: 'openCommit', hash: c.hash })}
            title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show what it changed`}
          >
            <span class="hash">{c.short}</span>
            <span class="work-main subject">{c.subject}</span>
            <span class="muted work-when">
              {c.author} · {ago(c.date)}
            </span>
          </button>
        ))}
    </>
  );
}

/** A clean-up of the ticket's history in progress: how far it is; compare, finish or cancel it. */
function CleanUpPanel({ ticket }: { ticket: TicketView }) {
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
        <button class="button secondary" onClick={() => send({ type: 'compareCleanUp' })} title="What still differs between the clean history and the branch">
          <i class="codicon codicon-diff" /> Compare
        </button>
      )}
      <button
        class="button secondary"
        onClick={() => send({ type: 'cancelCleanUp' })}
        title="Removes the clean-up's worktree and branch; the branch stays as it is"
      >
        Cancel
      </button>
      <button
        class={`button${ready ? '' : ' secondary'}`}
        disabled={!ready}
        onClick={() => send({ type: 'finishCleanUp' })}
        title={
          ready
            ? 'Keeps the old history, and moves the branch to the clean commits (asks first)'
            : 'Once the clean history ends at the same files, with nothing uncommitted'
        }
      >
        <i class="codicon codicon-check" /> Finish Clean-Up
      </button>
    </div>
  );
}

/**
 * Whether the ticket's work is merged into the base (read from git). A Done ticket with unmerged work warns, and offers
 * to merge it (a sibling ticket), dismiss it (superseded by another ticket) or open its branch.
 */
function MergePanel({ ticket }: { ticket: TicketView }) {
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
          <button class="button secondary" onClick={() => send({ type: 'mergeSibling' })} title="Adds a ticket, next to this one, to merge the branch (asks which, when there are several)">
            <i class="codicon codicon-git-merge" /> Merge…
          </button>
          <button class="button secondary" onClick={() => send({ type: 'dismissUnmerged' })} title="The work is superseded by another ticket (asks which)">
            Dismiss
          </button>
          <button
            class="button secondary"
            onClick={() => (hasWorktree ? send({ type: 'openWorktree', key: ticket.worktrees.find((w) => w.branch === branch)!.key }) : send({ type: 'checkout', branch: branch! }))}
            title={`Opens ${branch}: its worktree, or a new one for the branch`}
          >
            <i class="codicon codicon-git-branch" /> Open Branch
          </button>
        </>
      )}
    </div>
  );
}

/** Where the work on the ticket is: its worktrees (and branches without one), and its commits. */
function Work({ ticket }: { ticket: TicketView }) {
  const [allCommits, setAllCommits] = useState(false);
  const commits = allCommits ? ticket.commits : ticket.commits.slice(0, COMMITS_SHOWN);
  return (
    <section class="block">
      <div class="block-head">
        <h2>Work</h2>
      </div>
      <div class="work">
        <div class="work-head">
          <i class="codicon codicon-git-branch" /> Worktrees <span class="count">{ticket.worktrees.length}</span>
        </div>
        {!ticket.worktrees.length && <div class="work-empty muted">None yet. Create one above to work on it.</div>}
        {ticket.worktrees.map((ws) => (
          <button key={ws.key} class="work-row" onClick={() => send({ type: 'openWorktree', key: ws.key })} title="Open its tab in Flotilla">
            <span class="work-main">{ws.branch}</span>
            <span class={`state ${AGENT_STATE_CLASS[ws.attention] ?? ''}`}>{ws.status}</span>
            {ws.message && <span class="muted work-message">“{ws.message}”</span>}
            <span class="work-facts muted">
              {ws.changes > 0 && (
                <span title="Uncommitted changes">
                  <i class="codicon codicon-diff" /> {ws.changes}
                </span>
              )}
              {ws.upstream ? (
                (ws.ahead > 0 || ws.behind > 0) && (
                  <span title={`Against ${ws.upstream}: ${ws.ahead} to push, ${ws.behind} to pull`}>
                    {ws.ahead > 0 && `↑${ws.ahead}`} {ws.behind > 0 && `↓${ws.behind}`}
                  </span>
                )
              ) : (
                <span title="Not pushed yet">
                  <i class="codicon codicon-cloud" /> not pushed
                </span>
              )}
            </span>
            <i class="codicon codicon-arrow-right open-arrow" />
          </button>
        ))}
        {ticket.branches.map((b) => (
          <div key={b} class="work-row dim">
            <span class="work-main">{b}</span>
            <span class="muted">branch, no worktree</span>
            <button class="text-button work-action" onClick={() => send({ type: 'checkout', branch: b })} title="Create a worktree for this branch">
              <i class="codicon codicon-add" /> Worktree
            </button>
          </div>
        ))}
        <div class="work-head">
          <i class="codicon codicon-git-commit" /> Commits <span class="count">{ticket.commits.length}</span>
          {ticket.canCleanUp && (
            <button
              class="text-button work-head-action"
              onClick={() => send({ type: 'cleanUp' })}
              title="Rewrite the branch's commits into a clean history (an agent with you, or yourself). The old history is kept, and shown here."
            >
              <i class="codicon codicon-wand" /> Clean Up History…
            </button>
          )}
        </div>
        {!ticket.commits.length && <div class="work-empty muted">None yet. Commits on its branches, or that mention {ticket.item.id}, show here.</div>}
        {commits.map((c) => (
          <button
            key={c.hash}
            class="work-row commit"
            onClick={() => send({ type: 'openCommit', hash: c.hash })}
            title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
          >
            <span class="hash">{c.short}</span>
            <span class="work-main subject">{c.subject}</span>
            {c.branches.length ? (
              c.branches.map((b) => (
                <span key={b} class="branch-tag">
                  {b}
                </span>
              ))
            ) : (
              <span class="branch-tag mention" title={`Its message mentions ${ticket.item.id} or a linked issue`}>
                mentions it
              </span>
            )}
            <span class="muted work-when">
              {c.author} · {ago(c.date)}
            </span>
          </button>
        ))}
        {ticket.commits.length > COMMITS_SHOWN && (
          <button class="text-button work-more" onClick={() => setAllCommits(!allCommits)}>
            {allCommits ? 'Show fewer' : `Show all ${ticket.commits.length}`}
          </button>
        )}
        {ticket.history.length > 0 && (
          <>
            <div class="work-head">
              <i class="codicon codicon-history" /> Earlier Histories <span class="count">{ticket.history.length}</span>
            </div>
            {ticket.history.map((v) => (
              <HistoryVersionRow key={v.ref} version={v} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** A model as people say it: "claude-opus-5-5" is Opus 5.5, an alias ("sonnet") is Sonnet. */
function modelName(model: string): string {
  const m = /^(?:claude-)?([a-z]+)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?$/i.exec(model);
  if (!m) return model;
  const family = `${m[1][0].toUpperCase()}${m[1].slice(1)}`;
  return m[2] ? `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : family;
}

/** Every agent that worked on the ticket: its chat, its state, how much it reported. */
function Agents({ ticket }: { ticket: TicketView }) {
  return (
    <section class="block">
      <div class="block-head">
        <h2>Agents</h2>
      </div>
      <div class="agents">
        {ticket.agents.map((a) => {
          const state = CHAT_STATE[a.state] ?? CHAT_STATE.ended;
          return (
            <button
              key={a.id}
              class={`agent-row ${state.cls}`}
              onClick={() => send({ type: 'openChat', key: a.key, id: a.id })}
              title="Open this chat in Claude Code"
            >
              <span class="chat-icon small">
                <i class="codicon codicon-hubot" />
                <span class={`dot ${state.cls}`} />
              </span>
              <span class="agent-name">{a.agent}</span>
              <span class="chat-title">{a.title}</span>
              <span class={`state ${state.cls}`}>{state.label}</span>
              <span class="muted agent-meta">
                <i class="codicon codicon-git-branch" /> {a.branch}
              </span>
              {(a.model || a.effort) && (
                <span class="muted agent-meta" title={[a.model && `Model: ${a.model}`, a.effort && `Effort: ${a.effort}`].filter(Boolean).join('\n')}>
                  <i class="codicon codicon-chip" /> {[a.model && modelName(a.model), a.effort && `${a.effort} effort`].filter(Boolean).join(' · ')}
                </span>
              )}
              <span class="muted agent-meta">
                {a.reports} report{a.reports === 1 ? '' : 's'} · {ago(a.updated)}
              </span>
              <i class="codicon codicon-arrow-right open-arrow" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

type EntryKind = 'comment' | 'agent' | 'history';

/** People's comments (here or in the tracker), agents' reports, and Flotilla's notes (what happened). */
function kindOf(author: string): EntryKind {
  if (entryAgent(author) || author.toLowerCase() === 'agent') return 'agent';
  if (author === 'Flotilla' || !author) return 'history';
  return 'comment';
}

/** When an entry was written ("2026-10-11 09:30", local time); undefined if it doesn't say. */
function entryTime(date: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime() : undefined;
}

/** The entries (in their order) with the commits merged in by time, oldest first. */
function withCommits<E extends { date: string }>(entries: E[], commits: TicketView['commits']): Array<E | { commit: TicketView['commits'][number] }> {
  const pending = [...commits].sort((a, b) => a.date.localeCompare(b.date));
  const out: Array<E | { commit: TicketView['commits'][number] }> = [];
  for (const e of entries) {
    const at = entryTime(e.date);
    // Entries are written to the minute: a commit in that minute comes first.
    while (at !== undefined && pending.length && new Date(pending[0].date).getTime() < at + 60_000) out.push({ commit: pending.shift()! });
    out.push(e);
  }
  for (const c of pending) out.push({ commit: c });
  return out;
}

const TABS: Array<{ kind?: EntryKind; label: string }> = [
  { label: 'All' },
  { kind: 'comment', label: 'Comments' },
  { kind: 'agent', label: 'Agent Reports' },
  { kind: 'history', label: 'History' },
];

const EMPTY: Record<string, string> = {
  all: 'No comments or reports yet. Agents report here as they work.',
  comment: 'No comments yet.',
  agent: 'No agent reports yet. Start an agent: it reports here as it works.',
  history: 'Nothing has happened yet.',
};

function Activity({ ticket }: { ticket: TicketView }) {
  const [comment, setComment] = useState('');
  const [tab, setTab] = useState<EntryKind | undefined>(undefined);
  const post = () => {
    if (!comment.trim()) return;
    send({ type: 'comment', text: comment });
    setComment('');
    if (tab && tab !== 'comment') setTab(undefined);
  };
  const review = (verdict: 'approved' | 'changes') => {
    send({ type: 'userReview', verdict, text: comment });
    setComment('');
    if (tab && tab !== 'comment') setTab(undefined);
  };
  const asking = ticket.review?.state === 'asking' ? (ticket.review.implementer ?? 'The agent') : undefined;
  // A local item with work to review: the user can review it here, as in a pull request.
  const reviewable = !ticket.remote && ticket.canReview && ticket.item.status !== 'done';
  const shown = ticket.activity.filter((e) => !tab || kindOf(e.author) === tab);
  // Commits are part of what happened: in All and History, in time order among the entries.
  const commits = !tab || tab === 'history' ? ticket.commits : [];
  const feed = withCommits(shown, commits);
  return (
    <section class="block">
      <div class="block-head">
        <h2>Activity</h2>
      </div>
      <div class="tabs" role="tablist" aria-label="Show">
        {TABS.map((t) => {
          const count =
            ticket.activity.filter((e) => !t.kind || kindOf(e.author) === t.kind).length + (!t.kind || t.kind === 'history' ? ticket.commits.length : 0);
          return (
            <button key={t.label} role="tab" aria-selected={tab === t.kind} onClick={() => setTab(t.kind)}>
              {t.label}
              {count > 0 && <span class="count">{count}</span>}
            </button>
          );
        })}
      </div>
      {!feed.length && !ticket.loading && <div class="empty-text">{EMPTY[tab ?? 'all']}</div>}
      <ol class="feed">
        {feed.map((f, i) => {
          if ('commit' in f) {
            const c = f.commit;
            return (
              <li key={c.hash} class="entry kind-commit">
                <button
                  class="commit-line"
                  onClick={() => send({ type: 'openCommit', hash: c.hash })}
                  title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
                >
                  <i class="codicon codicon-git-commit" />
                  <span class="hash">{c.short}</span>
                  <span class="subject">{c.subject}</span>
                  {c.branches[0] && <span class="branch-tag">{c.branches[0]}</span>}
                  <span class="muted">
                    {c.author} · {ago(c.date)}
                  </span>
                </button>
              </li>
            );
          }
          const e = f;
          const kind = kindOf(e.author);
          const agentChat = kind === 'agent' && e.chat && !('pending' in e.chat) ? e.chat : undefined;
          return (
            <li key={`${e.date}${e.author}${i}`} class={`entry kind-${kind}`}>
              <div class="entry-head">
                <i class={`codicon codicon-${kind === 'agent' ? 'hubot' : (AUTHOR_ICON[e.author.toLowerCase()] ?? 'account')}`} />
                {/* Agents go by their names ("Nova-7"); the robot icon and the tag say what they are. */}
                <strong>{entryAgent(e.author) ?? (e.author || 'Note')}</strong>
                {kind === 'agent' && <span class="bot-tag">agent</span>}
                {e.date && <span class="muted">{e.date}</span>}
                {agentChat && (
                  <button
                    class="chat-chip"
                    onClick={() => send({ type: 'openChat', key: agentChat.key, id: agentChat.id })}
                    title={`Written in the chat "${agentChat.title}". Click to open it in Claude Code.`}
                  >
                    <span class={`dot ${CHAT_STATE[agentChat.state]?.cls ?? 'ended'}`} />
                    <i class="codicon codicon-comment-discussion" />
                    <span class="chat-chip-title">{agentChat.title}</span>
                  </button>
                )}
                {e.posted && (
                  <span class="posted" title={`Posted as a comment on ${e.posted}`}>
                    <i class="codicon codicon-check" /> Posted to {e.posted}
                  </span>
                )}
                {e.key && !e.posted && ticket.postTargets.length > 0 && kind !== 'history' && (
                  <button
                    class="text-button post-entry"
                    onClick={() => send({ type: 'postEntry', key: e.key! })}
                    title="Shows what will be posted and asks first"
                  >
                    <i class="codicon codicon-comment-unresolved" /> Post to {ticket.postTargets.length === 1 ? ticket.postTargets[0] : 'an Issue'}…
                  </button>
                )}
              </div>
              <Rendered html={e.html} empty="" />
              {kind === 'history' && e.chat && <ChatCard chat={e.chat} />}
            </li>
          );
        })}
      </ol>
      <div class="comment-box">
        <MarkdownBox
          value={comment}
          setValue={setComment}
          placeholder={
            asking
              ? `Answer ${asking}'s question (Markdown; Ctrl+Enter sends it, and ${asking} goes on)`
              : ticket.remote
                ? `Comment in ${ticket.remote.kind === 'jira' ? 'Jira (Markdown, converted to Jira formatting' : 'GitHub (Markdown'}; Ctrl+Enter posts it there)`
                : 'Add a comment (Markdown; paste or drop images; Ctrl+Enter posts)'
          }
          label="Comment"
          onSubmit={post}
          images={!ticket.remote}
        />
        <div class="actions-row">
          {reviewable && (
            <>
              <button
                class="button secondary"
                onClick={() => review('changes')}
                title="Sends the work back with your comment: an agent picks it up (its implementer's chat, resumed), and asks you first if it needs more context"
              >
                <i class="codicon codicon-request-changes" /> Request Changes
              </button>
              <button class="button secondary" onClick={() => review('approved')} title="Approves the work, with your comment if you wrote one">
                <i class="codicon codicon-check" /> Approve
              </button>
            </>
          )}
          <button class="button" disabled={!comment.trim()} onClick={post}>
            {asking ? 'Answer' : 'Comment'}
          </button>
        </div>
      </div>
    </section>
  );
}

interface MenuItem {
  key: string;
  label: string;
  icon: string;
  /** Classes on the item (colours its icon). */
  class?: string;
  detail?: string;
  checked?: boolean;
  onSelect(): void;
}

/** A button that opens a menu below it. */
function Dropdown({ class: cls, button, label, items }: { class: string; button: ComponentChildren; label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span class={`dropdown ${cls}`} ref={box}>
      <button
        class="dropdown-button priority-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!items.length}
        onClick={() => setOpen(!open)}
      >
        {button}
        {items.length > 0 && <i class="codicon codicon-chevron-down chev-small" />}
      </button>
      {open && (
        <span class="menu priority-menu" role="menu">
          {items.map((i) => (
            <button
              key={i.key}
              role={i.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={i.checked}
              class={i.class}
              title={i.detail}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
            >
              <i class={`codicon codicon-${i.icon}`} />
              <span>{i.label}</span>
              {i.detail && <span class="menu-detail">{i.detail}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

const LANE_ICON: Record<BacklogStatus, string> = {
  todo: 'circle-large-outline',
  doing: 'circle-large-filled',
  review: 'eye',
  done: 'pass-filled',
};

/** An issue's status, with the moves its tracker's workflow offers from it now. */
function StatusMenu({ ticket }: { ticket: TicketView }) {
  const remote = ticket.remote!;
  const moves = remote.edit?.transitions ?? [];
  return (
    <Dropdown
      class="status-menu"
      label={`Status: ${remote.statusName}${moves.length ? '. Change…' : ''}`}
      button={
        <>
          <i class={`codicon codicon-${LANE_ICON[ticket.item.status]}`} />
          <span>{remote.statusName || STATUSES.find((s) => s.status === ticket.item.status)?.label}</span>
        </>
      }
      items={moves.map((t) => ({
        key: t.id,
        // A move is named after its target status in most workflows; when it isn't, both show.
        label: t.name.toLowerCase() === t.to.toLowerCase() ? t.to : `${t.name} → ${t.to}`,
        icon: t.needs ? 'warning' : LANE_ICON[t.status],
        detail: t.needs ? `Needs ${t.needs.join(', ')}: done in the tracker` : undefined,
        onSelect: () => send({ type: 'transition', id: t.id }),
      }))}
    />
  );
}

/** An issue's priority, from the priorities its tracker has (P1–P5, Blocker…, whatever the site uses). */
function RemotePriority({ current, names }: { current?: string; names: string[] }) {
  const level = (name?: string) => priorityFromName(name);
  const icon = (name?: string) => {
    const l = level(name);
    return l ? PRIORITY[l].icon : 'circle-small';
  };
  const cur = level(current);
  return (
    <Dropdown
      class={`priority${cur ? ` p-${cur}` : ' unset'}`}
      label={`Priority: ${current ?? 'none'}. Change…`}
      button={
        <>
          <i class={`codicon codicon-${icon(current)}`} />
          <span>{current ?? 'Priority'}</span>
        </>
      }
      items={names.map((n) => ({
        key: n,
        label: n,
        icon: icon(n),
        class: level(n) ? `p-${level(n)}` : undefined,
        checked: n === current,
        onSelect: () => send({ type: 'remotePriority', name: n }),
      }))}
    />
  );
}

const MODELS: Array<{ model: string; label: string; detail: string }> = [
  { model: 'fable', label: 'Fable', detail: 'The most capable' },
  { model: 'opus', label: 'Opus', detail: 'Strong all-rounder' },
  { model: 'sonnet', label: 'Sonnet', detail: 'Fast and capable' },
  { model: 'haiku', label: 'Haiku', detail: 'Fastest, for small tasks' },
];

const modelLabel = (model: string) => MODELS.find((m) => m.model === model.toLowerCase())?.label ?? model;

/**
 * Which model the ticket's agents run and how hard they think: the ticket's choice, or the default (the settings, else
 * Claude Code's).
 */
function AgentPicker({ ticket }: { ticket: TicketView }) {
  const chosen = ticket.item.agent ?? {};
  const defaults = ticket.agentDefaults;
  const model = chosen.model ?? defaults.model;
  const effort = chosen.effort ?? defaults.effort;
  const defaultModel = defaults.model ? `Default (${modelLabel(defaults.model)})` : "Default (Claude Code's)";
  const defaultEffort = defaults.effort ? `Default (${defaults.effort})` : "Default (Claude Code's)";
  const custom = chosen.model && !MODELS.some((m) => m.model === chosen.model!.toLowerCase()) ? [chosen.model] : [];
  return (
    <>
      <Dropdown
        class={`priority agent-choice${chosen.model ? '' : ' unset'}`}
        label={`Agents' model: ${model ? modelLabel(model) : 'default'}. Change…`}
        button={
          <>
            <i class="codicon codicon-hubot" />
            <span>{model ? modelLabel(model) : 'Model'}</span>
          </>
        }
        items={[
          { key: '', label: defaultModel, icon: 'circle-small', checked: !chosen.model, onSelect: () => send({ type: 'agentModel', model: null }) },
          ...MODELS.map((m) => ({
            key: m.model,
            label: m.label,
            detail: m.detail,
            icon: 'hubot',
            checked: chosen.model?.toLowerCase() === m.model,
            onSelect: () => send({ type: 'agentModel', model: m.model }),
          })),
          ...custom.map((c) => ({ key: c, label: c, icon: 'hubot', checked: true, onSelect: () => send({ type: 'agentModel', model: c }) })),
          { key: 'other', label: 'Other Model…', icon: 'edit', onSelect: () => send({ type: 'agentModel', model: 'other' }) },
        ]}
      />
      <Dropdown
        class={`priority agent-choice${chosen.effort ? '' : ' unset'}`}
        label={`Agents' effort: ${effort ?? 'default'}. Change…`}
        button={
          <>
            <i class="codicon codicon-dashboard" />
            <span>{effort ? `${effort[0].toUpperCase()}${effort.slice(1)} effort` : 'Effort'}</span>
          </>
        }
        items={[
          { key: '', label: defaultEffort, icon: 'circle-small', checked: !chosen.effort, onSelect: () => send({ type: 'agentEffort', effort: null }) },
          ...AGENT_EFFORTS.map((e) => ({
            key: e,
            label: `${e[0].toUpperCase()}${e.slice(1)}`,
            icon: 'dashboard',
            checked: chosen.effort === e,
            onSelect: () => send({ type: 'agentEffort', effort: e }),
          })),
        ]}
      />
    </>
  );
}

const AGENT_STATE_CLASS: Record<string, string | undefined> = {
  'waiting-for-input': 'waiting',
  error: 'error',
  working: 'working',
  done: 'done',
};

function App() {
  const [ticket, setTicket] = useState<TicketView>();
  useEffect(() => {
    const listener = (e: MessageEvent<TicketHostMessage>) => {
      const m = e.data;
      if (m.type === 'ticket') setTicket(m.ticket);
      else if (m.type === 'imageSaved') {
        imageReplies.get(m.requestId)?.(m.markdown);
        imageReplies.delete(m.requestId);
      }
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  if (!ticket) return <div class="empty-text">Loading…</div>;
  const worktrees = ticket.worktrees;
  const done = ticket.item.status === 'done';
  return (
    <main class="ticket">
      <header>
        <div class="meta">
          <span class="ticket-id">{ticket.item.id}</span>
          {ticket.remote ? (
            <div class="remote-meta">
              <StatusMenu ticket={ticket} />
              <button class="source" onClick={() => send({ type: 'openRemote' })} title={`Open it in ${ticket.remote.label}`}>
                <i class={`codicon codicon-${ticket.remote.kind === 'github' ? 'github' : 'issues'}`} />
                {ticket.remote.label}
                <i class="codicon codicon-link-external" />
              </button>
            </div>
          ) : (
            <div class="segmented" role="radiogroup" aria-label="Status">
              {STATUSES.map((s) => (
                <button key={s.status} role="radio" aria-checked={ticket.item.status === s.status} onClick={() => send({ type: 'status', status: s.status })}>
                  <i class={`codicon codicon-${s.icon}`} /> {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {ticket.item.proposed && (
          <div class="proposal-banner">
            <i class="codicon codicon-lightbulb" />
            <span>
              {ticket.item.proposed.by ? `${ticket.item.proposed.by} (an agent)` : 'An agent'} proposed this ticket. Accept it into the backlog, or dismiss it.
            </span>
            <button class="button" onClick={() => send({ type: 'accept' })}>
              <i class="codicon codicon-check" /> Accept
            </button>
            <button class="button secondary" onClick={() => send({ type: 'dismiss' })}>
              Dismiss
            </button>
          </div>
        )}
        <Title ticket={ticket} />
        <div class="properties">
          {ticket.parent && (
            <button
              class="parent-link"
              onClick={() => send({ type: 'openTicket', id: ticket.parent!.id })}
              title={`Part of ${ticket.parent.id}: ${ticket.parent.title}`}
            >
              <i class="codicon codicon-type-hierarchy-super" />
              Part of <strong>{ticket.parent.id}</strong> <span class="muted">{ticket.parent.title}</span>
            </button>
          )}
          {ticket.remote?.edit?.priorities ? (
            <RemotePriority current={ticket.remote.priorityName} names={ticket.remote.edit.priorities} />
          ) : (
            <PriorityPicker value={ticket.item.priority} onChange={ticket.remote ? undefined : (priority) => send({ type: 'priority', priority })} />
          )}
          {!ticket.remote && <AgentPicker ticket={ticket} />}
          {ticket.links.map((l) => (
            <span key={l.id} class="link-chip">
              <button
                class="link-open"
                onClick={() => send({ type: 'openLink', id: l.id })}
                title={`${l.title}\nOpen it in ${l.kind === 'jira' ? 'Jira' : 'GitHub'}`}
              >
                <i class={`codicon codicon-${l.kind === 'github' ? 'github' : 'issues'}`} />
                <span class="link-id">{l.id}</span>
                {l.statusName && <span class="muted">{l.statusName}</span>}
              </button>
              <button class="link-remove" onClick={() => send({ type: 'unlink', id: l.id })} title={`Unlink ${l.id}`} aria-label={`Unlink ${l.id}`}>
                <i class="codicon codicon-close" />
              </button>
            </span>
          ))}
          {!ticket.remote && (
            <button class="add-link" onClick={() => send({ type: 'link' })} title="Link it to an issue in Jira or GitHub Issues">
              <i class="codicon codicon-link" /> {ticket.links.length ? 'Link' : 'Link Issue'}
            </button>
          )}
        </div>
        <div class="toolbar">
          {!done && (
            <button
              class="button"
              onClick={() => send({ type: 'start', agent: true })}
              title={
                ticket.item.agent?.model || ticket.item.agent?.effort || ticket.agentDefaults.model || ticket.agentDefaults.effort
                  ? 'Creates its worktree if needed and starts a Claude Code agent there, with the model and effort chosen (in a terminal: Claude Code’s panel can’t be started with them); it reports below'
                  : 'Creates its worktree if needed and starts a Claude Code agent there; it reports below'
              }
            >
              <i class="codicon codicon-play" /> {worktrees.length ? 'Start an Agent' : 'Start with an Agent'}
            </button>
          )}
          {!done && (
            <button
              class="button secondary"
              onClick={() => send({ type: 'start', agent: false })}
              title="Creates a worktree and branch for it, without an agent (an epic can have several)"
            >
              <i class="codicon codicon-git-branch" /> {worktrees.length ? 'Add a Worktree' : 'Create Worktree'}
            </button>
          )}
          {!ticket.remote && (
            <>
              <button class="button secondary" onClick={() => send({ type: 'writeWithAI' })} title="Opens a Claude Code chat that helps write this ticket">
                <i class="codicon codicon-sparkle" /> Write with Claude
              </button>
              <button class="button secondary" onClick={() => send({ type: 'openFile' })} title="Edit the whole ticket as Markdown">
                <i class="codicon codicon-go-to-file" /> Open as Markdown
              </button>
              {ticket.canReview && !ticket.review && (
                <button class="button secondary" onClick={() => send({ type: 'startReview' })} title="Another agent reviews the work and gives a verdict here">
                  <i class="codicon codicon-eye" /> Start Review
                </button>
              )}
              {ticket.canCreateIssue && !ticket.links.length && (
                <button
                  class="button secondary"
                  onClick={() => send({ type: 'createIssue' })}
                  title="Creates an issue from this ticket in Jira or GitHub (asks first) and links it"
                >
                  <i class="codicon codicon-cloud-upload" /> Create Issue…
                </button>
              )}
            </>
          )}
        </div>
        {ticket.review && <ReviewPanel ticket={ticket} />}
        {ticket.rewrite && <CleanUpPanel ticket={ticket} />}
        {((ticket.merge && ticket.merge.state !== 'none') || ticket.item.supersededBy) && <MergePanel ticket={ticket} />}
      </header>
      {ticket.error && (
        <div class="error-note">
          <i class="codicon codicon-warning" /> {ticket.remote ? `Couldn't read it from ${ticket.remote.label}` : "Couldn't load it"}: {ticket.error}
        </div>
      )}
      <Description ticket={ticket} />
      {ticket.children.length > 0 && <Parts ticket={ticket} />}
      {(worktrees.length > 0 || ticket.branches.length > 0 || ticket.commits.length > 0 || ticket.history.length > 0) && <Work ticket={ticket} />}
      {ticket.agents.length > 0 && <Agents ticket={ticket} />}
      <Activity ticket={ticket} />
    </main>
  );
}

/** Shows what went wrong instead of a blank tab if the view fails to render. */
class ErrorBoundary extends Component<{ children: ComponentChildren }, { error?: string }> {
  state: { error?: string } = {};
  componentDidCatch(error: unknown) {
    this.setState({
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div class="error-note">
        <i class="codicon codicon-warning" /> This ticket couldn't be shown. Close and reopen it; if it keeps happening, this is what failed:
        <pre>{this.state.error}</pre>
      </div>
    );
  }
}

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('root')!,
);
