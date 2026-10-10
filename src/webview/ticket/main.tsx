import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BacklogStatus } from '../../features/backlog/backlog';
import type { TicketHostMessage, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import './ticket.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const send = (message: TicketWebviewMessage) => vscode.postMessage(message);

const STATUSES: Array<{ status: BacklogStatus; label: string; icon: string }> = [
  { status: 'todo', label: 'To Do', icon: 'circle-large-outline' },
  { status: 'doing', label: 'In Progress', icon: 'circle-large-filled' },
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
      void readAsBase64(file).then((data) => send({ type: 'image', requestId, name: file.name || 'pasted.png', data }));
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
  return <div class="rendered" dangerouslySetInnerHTML={{ __html: html }} />;
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
  if (ticket.remote) return <h1 class="title readonly">{ticket.item.title}</h1>;
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
    <h1 class="title" title="Click to edit" onClick={() => setEditing(true)}>
      {ticket.item.title}
    </h1>
  );
}

function Description({ ticket }: { ticket: TicketView }) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const save = () => {
    if (draft !== undefined && draft !== ticket.description) send({ type: 'description', text: draft });
    setDraft(undefined);
  };
  return (
    <section class="block">
      <div class="block-head">
        <h2>Description</h2>
        {draft === undefined && !ticket.remote && (
          <button class="text-button" onClick={() => setDraft(ticket.description)}>
            <i class="codicon codicon-edit" /> Edit
          </button>
        )}
        {ticket.remote && (
          <button class="text-button" onClick={() => send({ type: 'openRemote' })}>
            <i class="codicon codicon-link-external" /> Edit in {ticket.remote.kind === 'jira' ? 'Jira' : 'GitHub'}
          </button>
        )}
      </div>
      {draft === undefined ? (
        <div onDblClick={() => !ticket.remote && setDraft(ticket.description)}>
          <Rendered html={ticket.descriptionHtml} empty="No description yet. Edit it, or have Claude write it." />
        </div>
      ) : (
        <>
          <MarkdownBox
            value={draft}
            setValue={setDraft}
            placeholder="What and why, in Markdown. Paste or drop images. Ctrl+Enter saves."
            label="Description"
            onSubmit={save}
            autoFocus
            minRows={8}
          />
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

const AUTHOR_ICON: Record<string, string> = { you: 'account', agent: 'hubot', flotilla: 'info' };

function Activity({ ticket }: { ticket: TicketView }) {
  const [comment, setComment] = useState('');
  const post = () => {
    if (!comment.trim()) return;
    send({ type: 'comment', text: comment });
    setComment('');
  };
  return (
    <section class="block">
      <div class="block-head">
        <h2>Activity</h2>
      </div>
      {!ticket.activity.length && <div class="empty-text">No comments or reports yet. Agents report here as they work.</div>}
      <ol class="feed">
        {ticket.activity.map((e, i) => (
          <li key={i} class={`entry author-${e.author.toLowerCase()}`}>
            <div class="entry-head">
              <i class={`codicon codicon-${AUTHOR_ICON[e.author.toLowerCase()] ?? 'account'}`} />
              <strong>{e.author || 'Note'}</strong>
              {e.date && <span class="muted">{e.date}</span>}
            </div>
            <Rendered html={e.html} empty="" />
          </li>
        ))}
      </ol>
      <div class="comment-box">
        <MarkdownBox
          value={comment}
          setValue={setComment}
          placeholder={
            ticket.remote
              ? `Comment in ${ticket.remote.kind === 'jira' ? 'Jira' : 'GitHub'} (Ctrl+Enter posts it there)`
              : 'Add a comment (Markdown; paste or drop images; Ctrl+Enter posts)'
          }
          label="Comment"
          onSubmit={post}
          images={!ticket.remote}
        />
        <div class="actions-row">
          <button class="button" disabled={!comment.trim()} onClick={post}>
            Comment
          </button>
        </div>
      </div>
    </section>
  );
}

const AGENT_STATE_CLASS: Record<string, string | undefined> = { 'waiting-for-input': 'waiting', error: 'error', working: 'working', done: 'done' };

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
            <button class="source" onClick={() => send({ type: 'openRemote' })} title={`Open it in ${ticket.remote.label}`}>
              <i class={`codicon codicon-${ticket.remote.kind === 'github' ? 'github' : 'issues'}`} />
              {ticket.remote.label} · {ticket.remote.statusName}
              <i class="codicon codicon-link-external" />
            </button>
          ) : (
            <div class="segmented" role="radiogroup" aria-label="Status">
              {STATUSES.map((s) => (
                <button
                  key={s.status}
                  role="radio"
                  aria-checked={ticket.item.status === s.status}
                  onClick={() => send({ type: 'status', status: s.status })}
                >
                  <i class={`codicon codicon-${s.icon}`} /> {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <Title ticket={ticket} />
        <div class="toolbar">
          {!done && (
            <button
              class="button"
              onClick={() => send({ type: 'start', agent: true })}
              title="Creates its worktree if needed and starts a Claude Code agent there; it reports below"
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
              <button
                class="button secondary"
                onClick={() => send({ type: 'writeWithAI' })}
                title="Opens a Claude Code chat that helps write this ticket"
              >
                <i class="codicon codicon-sparkle" /> Write with Claude
              </button>
              <button class="button secondary" onClick={() => send({ type: 'openFile' })} title="Edit the whole ticket as Markdown">
                <i class="codicon codicon-go-to-file" /> Open as Markdown
              </button>
            </>
          )}
        </div>
        {worktrees.length > 0 && (
          <div class="worktrees">
            {worktrees.map((ws) => (
              <button key={ws.key} class="worktree" onClick={() => send({ type: 'openWorktree', key: ws.key })} title="Open its tab in Flotilla">
                <i class="codicon codicon-git-branch" />
                <span>{ws.branch}</span>
                <span class={`state ${AGENT_STATE_CLASS[ws.attention] ?? ''}`}>{ws.status}</span>
                {ws.message && <span class="muted">“{ws.message}”</span>}
              </button>
            ))}
          </div>
        )}
      </header>
      {ticket.error && (
        <div class="error-note">
          <i class="codicon codicon-warning" /> Couldn't read it from {ticket.remote?.label ?? 'its tracker'}: {ticket.error}
        </div>
      )}
      <Description ticket={ticket} />
      <Activity ticket={ticket} />
    </main>
  );
}

render(<App />, document.getElementById('root')!);
