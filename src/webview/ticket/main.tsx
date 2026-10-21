import { Component, render, type ComponentChildren, type JSX } from 'preact';
import { formatTokens } from '../../features/chats/usage';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { AGENT_EFFORTS, entryAgent, priorityFromName, type BacklogPriority, type BacklogStatus } from '../../features/backlog/backlog';
import { mergeLabel, unmergedWarning } from '../../features/backlog/merged';
import { mergeActions } from '../../features/backlog/mergeStates';
import { fixesFor, fixLabel, heldBy, type ReviewFix } from '../../features/backlog/review';
import { entryRound, foldRounds, foldTitle, openEntry, reviewOutcome, type FeedGroup, type RoundFold, type RoundInfo } from '../../features/backlog/rounds';
import { answerComment, answerFromText, answerOf, answersIn, choose, defaultAnswer, type Answer } from '../../features/backlog/report';
import { entryDate, summaryOf } from '../../features/backlog/ticket';
import { capitalize, conflictsOf } from '../../features/backlog/mainDrift';
import { TURN_ICON, TURN_LABEL, turnOf, turnSentence } from '../../features/backlog/turn';
import type { AskTurn, AskView } from '../../features/backlog/ask';
import type { AgentChatView, QueuedView, ReportView, TicketCiView, TicketHostMessage, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { queuedNeed } from '../../features/backlog/needs';
import { fileKind, tooLarge } from '../../features/backlog/media';
import { drawDiagrams } from './diagrams';
import { formatEdit, pasteLink, type Format, type Markup, type TextEdit } from './format';
import { Attachments, Diagram, diagramsIn, openMedia, SHOW_ENTRY, showEntry, shownDiagram } from './attachments';
import { DEMO_SECTION, DemoSection } from './demo';
import { demoLength } from '../../features/backlog/demo';
import { applyTicketParts } from '../ticketParts';
import { actionKey } from '../ticketActions';
import { activeAgents, lastReport, runningFor } from '../activeAgents';
import { PRIORITY, PriorityPicker } from '../ui/priority';
import '../ui/priority.css';
import { ticketStatus, type Ask } from '../ticketStatus';
import './ticket.css';
import { TicketCi } from './ci';
import { ciWord } from '../../features/ci/summary';
import { ciMovedPast, type CiStop } from '../../features/backlog/ciStop';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const send = (message: TicketWebviewMessage) => vscode.postMessage(message);

/**
 * The actions the host hasn't finished, by actionKey: "working…" shows from the click until the host says it's done
 * (it does so for every action, whether it posted, failed or did nothing).
 */
const working = new Map<string, string>();
const workingListeners = new Set<() => void>();
const doneListeners = new Set<(message: TicketWebviewMessage, failed: boolean) => void>();

const notifyWorking = () => workingListeners.forEach((f) => f());

/** Sends an action, and shows it as working (its label) until the host is done with it. */
function act(message: TicketWebviewMessage, label = 'Working…') {
  working.set(actionKey(message), label);
  notifyWorking();
  send(message);
}

/** The label of an action in progress (undefined when it isn't), re-rendered as it starts and ends. */
function useWorking(message: TicketWebviewMessage): string | undefined {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    workingListeners.add(listener);
    return () => void workingListeners.delete(listener);
  }, []);
  return working.get(actionKey(message));
}

/** Comments sent and not yet done with: each shows at once as an entry, marked "Sending…". */
type SentComment = { text: string; date: string; at: number };
let sendingComments: SentComment[] = [];
const sendingListeners = new Set<() => void>();
/** How many entries the view shows: a comment sent now is confirmed by an entry after these. */
let shownEntries = 0;

/** Sends a comment (from anywhere in the ticket): it shows at once, marked as sending, until the host is done with it. */
function sendComment(text: string, replyTo?: string) {
  sendingComments = [...sendingComments, { text, date: entryDate(new Date()), at: shownEntries }];
  sendingListeners.forEach((f) => f());
  act({ type: 'comment', text, ...(replyTo ? { replyTo } : {}) }, 'Sending…');
}

type ActivityEntry = TicketView['activity'][number];

/** The window event a Reply button sends (BL-126): the comment box replies to that entry (its detail). */
const REPLY_TO = 'flotilla-reply-to';

/** Who an entry is by, as the ticket names it: an agent by its name. */
const byName = (e: Pick<ActivityEntry, 'author'>) => entryAgent(e.author) ?? (e.author || 'Note');

function useSending(): SentComment[] {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    sendingListeners.add(listener);
    return () => void sendingListeners.delete(listener);
  }, []);
  return sendingComments;
}

/** Called when the host is done with an action: failed if it threw. */
function finished(message: TicketWebviewMessage, failed: boolean) {
  working.delete(actionKey(message));
  notifyWorking();
  if (message.type === 'comment') {
    const i = sendingComments.findIndex((c) => c.text === message.text);
    if (i >= 0) {
      sendingComments = sendingComments.filter((_, j) => j !== i);
      sendingListeners.forEach((f) => f());
    }
  }
  if (message.type === 'run') {
    // The Run button of a run block (set on click, in Rendered): its working state ends.
    document.querySelectorAll<HTMLElement>(`[data-run-key="${CSS.escape(message.key)}"][data-run-index="${message.index}"]`).forEach((run) => {
      run.removeAttribute('data-busy');
      (run as HTMLButtonElement).disabled = false;
    });
  }
  doneListeners.forEach((f) => f(message, failed));
}

/** A button for an action: it says "working…" (after its label) from the click until the host is done with it. */
function ActionButton({
  message,
  working: label,
  children,
  ...props
}: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { message: TicketWebviewMessage; working?: string }) {
  const busy = useWorking(message);
  return (
    <button {...props} disabled={props.disabled || !!busy} aria-busy={!!busy} onClick={() => act(message, label)}>
      {children}
      {busy && <WorkingTag label={busy} />}
    </button>
  );
}

/**
 * Create Worktree ▾: a click creates a new worktree at once, its branch named without asking (numbered when the name is
 * taken); the menu's item asks for the branch name first. While one is being created, it says so and waits.
 */
function CreateWorktreeButton({ creating, another }: { creating: boolean; another: boolean }) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);
  if (creating) {
    return (
      <button class="button secondary" disabled aria-busy="true">
        <i class="codicon codicon-loading codicon-modifier-spin" /> Creating worktree…
      </button>
    );
  }
  return (
    <span class="split-button">
      <ActionButton
        class="button secondary"
        message={{ type: 'start', agent: false, newWorktree: 'auto' }}
        working="Creating…"
        title="Creates a new worktree and branch for it at once, without an agent (an epic can have several)"
      >
        <i class="codicon codicon-git-branch" /> {another ? 'Add a Worktree' : 'Create Worktree'}
      </ActionButton>
      <button
        class="button secondary more"
        aria-label="More Ways to Create a Worktree…"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={(e) => {
          e.stopPropagation();
          setMenu(!menu);
        }}
      >
        <i class="codicon codicon-chevron-down" />
      </button>
      {menu && (
        <span class="menu priority-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              act({ type: 'start', agent: false, newWorktree: 'named' }, 'Creating…');
            }}
          >
            <i class="codicon codicon-edit" />
            <span>Create Worktree with Branch Name…</span>
          </button>
        </span>
      )}
    </span>
  );
}

/** "working…" beside an action that's in progress. */
function WorkingTag({ label }: { label: string }) {
  return (
    <span class="action-busy" role="status">
      <i class="codicon codicon-loading codicon-modifier-spin" /> {label}
    </span>
  );
}

const STATUSES: Array<{ status: BacklogStatus; label: string; icon: string }> = [
  { status: 'todo', label: 'To Do', icon: 'circle-large-outline' },
  { status: 'doing', label: 'In Progress', icon: 'circle-large-filled' },
  { status: 'review', label: 'In Review', icon: 'eye' },
  { status: 'done', label: 'Done', icon: 'pass-filled' },
];

/** Replies to pasted or dropped images, by request id. */
const imageReplies = new Map<number, (markdown: string) => void>();
let nextImage = 1;
/** Replies to a Markdown box's Preview, by request id. */
const previewReplies = new Map<number, (html: string) => void>();
let nextPreview = 1;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Saves the images and videos among files next to the ticket and inserts links to them at the textarea's cursor. One
 * over its kind's size limit isn't sent: the host says why.
 */
async function attachImages(files: FileList | File[], area: HTMLTextAreaElement, setText: (text: string) => void): Promise<boolean> {
  const images = [...files].filter((f) => fileKind(f));
  for (const file of images) {
    const kind = fileKind(file)!;
    if (tooLarge(kind, file.size)) {
      send({ type: 'mediaRefused', name: file.name || 'pasted', kind, size: file.size });
      continue;
    }
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
    if (!markdown) continue;
    const at = area.selectionStart ?? area.value.length;
    const before = area.value.slice(0, at);
    const text = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${markdown}\n${area.value.slice(at)}`;
    setText(text);
  }
  return images.length > 0;
}

/** What the Mention button inserts: the prefix of this ticket's id (BL-, or a tracker's PROJ-). */
const mentionPrefix = (id: string) => /^(.*?-)\d+$/.exec(id)?.[1] ?? '';

/** The formatting toolbar's buttons (BL-129), with their keys. */
const FORMATS: Array<{ format: Format; icon: string; label: string; key?: string }> = [
  { format: 'bold', icon: 'bold', label: 'Bold', key: 'b' },
  { format: 'italic', icon: 'italic', label: 'Italic', key: 'i' },
  { format: 'code', icon: 'code', label: 'Code' },
  { format: 'codeBlock', icon: 'file-code', label: 'Code block' },
  { format: 'link', icon: 'link', label: 'Link', key: 'k' },
  { format: 'bullets', icon: 'list-unordered', label: 'Bulleted list' },
  { format: 'numbers', icon: 'list-ordered', label: 'Numbered list' },
  { format: 'quote', icon: 'quote', label: 'Quote' },
  { format: 'mention', icon: 'mention', label: 'Mention a ticket or comment' },
];

/**
 * Makes an edit in the textarea as typing would, so Ctrl+Z undoes it; where the browser won't, the value is set.
 * The textarea's input event updates the box's state.
 */
function editArea(el: HTMLTextAreaElement, edit: TextEdit, setValue: (text: string) => void): void {
  const expected = el.value.slice(0, edit.from) + edit.insert + el.value.slice(edit.to);
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  const typed = edit.insert ? document.execCommand('insertText', false, edit.insert) : edit.from === edit.to || document.execCommand('delete');
  if (!typed || el.value !== expected) {
    el.value = expected;
    setValue(expected);
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}

/**
 * A Markdown box that grows with its text and takes pasted or dropped images. With format, it has a toolbar (in that
 * markup) and, for Markdown, Write and Preview tabs: Preview renders the text as the activity shows it.
 */
function MarkdownBox({
  value,
  setValue,
  placeholder,
  label,
  onSubmit,
  autoFocus,
  minRows = 3,
  images = true,
  format,
  mention = '',
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
  /** The toolbar, writing this markup (none without). */
  format?: Markup;
  /** What the Mention button inserts: the ticket ids' prefix. */
  mention?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, preview === undefined]);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);
  const apply = (f: Format) => {
    const el = area.current;
    if (el) editArea(el, formatEdit(el.value, el.selectionStart, el.selectionEnd, f, format, mention), setValue);
  };
  const showPreview = () => {
    const requestId = nextPreview++;
    setPreview('');
    previewReplies.set(requestId, (html) => setPreview((shown) => (shown === undefined ? undefined : html)));
    send({ type: 'preview', requestId, text: value });
  };
  const write = () => {
    setPreview(undefined);
    setTimeout(() => area.current?.focus());
  };
  const box = (
    <textarea
      ref={area}
      class="md-box"
      hidden={preview !== undefined}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
          return;
        }
        const key = format && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && FORMATS.find((f) => f.key === e.key.toLowerCase());
        if (key) {
          // Not on to VS Code, where Ctrl+B toggles the sidebar and Ctrl+K starts a chord.
          e.preventDefault();
          e.stopPropagation();
          apply(key.format);
        }
      }}
      onPaste={(e) => {
        const files = e.clipboardData?.files;
        if (images && files?.length && [...files].some((f) => fileKind(f))) {
          e.preventDefault();
          void attachImages(files, area.current!, setValue);
          return;
        }
        const el = area.current!;
        const link = format && pasteLink(el.value, el.selectionStart, el.selectionEnd, e.clipboardData?.getData('text/plain') ?? '', format);
        if (link) {
          e.preventDefault();
          editArea(el, link, setValue);
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
  if (!format) return box;
  const key = (k?: string) => (k ? ` (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}${k.toUpperCase()})` : '');
  return (
    <div class="md-editor">
      <div class="md-toolbar">
        {format === 'markdown' && (
          <span class="md-tabs" role="tablist">
            <button role="tab" class="md-tab" aria-selected={preview === undefined} onClick={write}>
              Write
            </button>
            <button role="tab" class="md-tab" aria-selected={preview !== undefined} onClick={showPreview}>
              Preview
            </button>
          </span>
        )}
        {preview === undefined && (
          <span class="md-formats" role="toolbar" aria-label="Formatting">
            {FORMATS.map((f) => (
              <button
                key={f.format}
                class="icon-button"
                title={f.label + key(f.key)}
                aria-label={f.label}
                // The textarea keeps its focus and selection.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(f.format)}
              >
                <i class={`codicon codicon-${f.icon}`} />
              </button>
            ))}
          </span>
        )}
      </div>
      {box}
      {preview !== undefined && (
        <div class="md-preview" style={{ minHeight: `${minRows * 1.5 + 1}em` }}>
          {preview || !value.trim() ? <Rendered html={preview} empty="Nothing to preview." /> : <div class="rendered empty-text">Rendering…</div>}
        </div>
      )}
    </div>
  );
}

/** Rendered Markdown from the host (VS Code's renderer; scripts are blocked by the page's policy). */
function Rendered({ html, empty }: { html: string; empty: string }) {
  const el = useRef<HTMLDivElement>(null);
  // Mermaid blocks become diagrams, again whenever the html is new.
  useEffect(() => {
    if (el.current) void drawDiagrams(el.current);
  }, [html]);
  // A demo's video says how long it plays once it knows (a GIF's length comes with the html, BL-111).
  useEffect(() => {
    el.current?.querySelectorAll<HTMLVideoElement>('.demo-inline video').forEach((v) => {
      const show = () => {
        const label = v.closest('.demo-inline')?.querySelector('.demo-length');
        if (label && Number.isFinite(v.duration)) label.textContent = `Recorded demo · ${demoLength(v.duration)}`;
      };
      if (v.readyState >= 1) show();
      else v.addEventListener('loadedmetadata', show, { once: true });
    });
  }, [html]);
  if (!html) return <div class="rendered empty-text">{empty}</div>;
  // Links open here (files at their lines, in the ticket's worktree) or in the browser: not inside the view.
  const onClick = (e: MouseEvent) => {
    // The Run button of a run block in an agent's report (the host puts it in the html).
    const run = (e.target as HTMLElement).closest<HTMLElement>('[data-run-key]');
    if (run) {
      // The button is in the host's html: its working state is set here, and cleared when the host is done.
      run.dataset.busy = 'Running…';
      (run as HTMLButtonElement).disabled = true;
      act({ type: 'run', key: run.dataset.runKey!, index: Number(run.dataset.runIndex), ...(run.dataset.runTry ? { try: true } : {}) }, 'Running…');
      return;
    }
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    send({ type: 'openHref', href });
  };
  return <div ref={el} class="rendered" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
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
  // With activity, the description folds to its first lines (the history is what's new).
  const foldable = ticket.activity.length > 0;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Measured while folded only: unfolded, it always fits.
    const el = text.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [ticket.descriptionHtml, foldable, expanded]);
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
        <>
          <div ref={text} class={foldable && !expanded ? 'description folded' : 'description'} onDblClick={() => editable && setDraft(ticket.description)}>
            <Rendered html={ticket.descriptionHtml} empty={ticket.remote ? 'No description.' : 'No description yet. Edit it, or discuss it with an agent.'} />
          </div>
          {foldable && (overflows || expanded) && (
            <button class="text-button fold-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              <i class={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`} /> {expanded ? 'Fold the description' : 'Show the whole description'}
            </button>
          )}
        </>
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
                  : 'What and why, in Markdown. Paste or drop images and videos. Ctrl+Enter saves.'
            }
            label="Description"
            onSubmit={save}
            autoFocus
            minRows={8}
            images={!ticket.remote}
            format={jira ? 'jira' : 'markdown'}
            mention={mentionPrefix(ticket.item.id)}
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

/** A question in the Ask chat, and its answer: streaming in as plain text, rendered once it's finished. */
function AskTurnView({ turn: t, index }: { turn: AskTurn; index: number }) {
  const [posting, setPosting] = useState(false);
  const finished = t.state === 'done' || (t.state === 'stopped' && !!t.answer.trim());
  return (
    <div class={`ask-turn ${t.state}`}>
      <div class="ask-question">{t.question}</div>
      <div class="ask-answer">
        {t.html ? <Rendered html={t.html} empty="" /> : t.answer && <div class="ask-streaming">{t.answer}</div>}
        {t.activity && (
          <div class="ask-activity">
            <i class="codicon codicon-loading codicon-modifier-spin" /> {t.activity}
          </div>
        )}
        {t.state === 'stopped' && <div class="hint">Stopped.</div>}
        {t.state === 'failed' && (
          <div class="error-note">
            <i class="codicon codicon-warning" /> {t.error}
          </div>
        )}
        {finished && (
          <div class="ask-actions">
            {t.posted ? (
              <span class="muted">
                <i class="codicon codicon-check" /> Posted to the ticket
              </span>
            ) : (
              <button
                class="text-button"
                disabled={posting}
                onClick={() => {
                  setPosting(true);
                  send({ type: 'askPost', index });
                }}
                title="Adds the question and this answer to the ticket's activity, as your comment"
              >
                <i class="codicon codicon-comment" /> Post to Ticket
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Ask (BL-80): a small chat about the ticket, off the record. Folded until opened. What's asked and answered shows only
 * here: it isn't written to the ticket, agents don't see it, and it's gone when the tab closes.
 */
function AskPane({ ask }: { ask?: AskView }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const turns = ask?.turns ?? [];
  const last = turns[turns.length - 1];
  const busy = !!ask?.busy;
  const stopping = busy && last?.state === 'stopped';
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);
  // The chat follows its answer while its end is in sight; scrolled away (to the activity), it stays put.
  const following = useRef(true);
  useEffect(() => {
    const el = end.current;
    if (!open || !el) return;
    const seen = new IntersectionObserver(([e]) => (following.current = e.isIntersecting));
    seen.observe(el);
    return () => seen.disconnect();
  }, [open]);
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: 'nearest' });
  }, [open, turns.length]);
  useEffect(() => {
    if (open && following.current) end.current?.scrollIntoView({ block: 'nearest' });
  }, [last?.answer.length, last?.state, last?.activity]);
  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    send({ type: 'ask', text });
    setDraft('');
  };
  return (
    <section class="block ask">
      <div class="block-head">
        <button class="ask-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <i class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
          <h2>Ask</h2>
          <span class="muted">{open ? "Off the record: it isn't written to the ticket, and agents don't see it" : 'A quick question about this ticket, off the record'}</span>
        </button>
        {open && turns.length > 0 && (
          <span class="head-actions">
            <button class="text-button" onClick={() => send({ type: 'askNew' })} title="Starts over: this chat is forgotten">
              <i class="codicon codicon-add" /> New Question
            </button>
          </span>
        )}
      </div>
      {open && (
        <div class="ask-chat">
          {turns.map((t, i) => (
            <AskTurnView key={i} turn={t} index={i} />
          ))}
          <div class="ask-input">
            <textarea
              ref={box}
              rows={2}
              value={draft}
              placeholder={turns.length ? 'A follow-up… (Enter asks, Shift+Enter starts a new line)' : "What's this for? How far is it? Which files does it touch? (Enter asks)"}
              aria-label="Ask about this ticket"
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {busy ? (
              <button class="button secondary" disabled={stopping} onClick={() => send({ type: 'askStop' })} title="Stops the answer; what it wrote so far stays">
                <i class="codicon codicon-debug-stop" /> {stopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button class="button" disabled={!draft.trim()} onClick={submit}>
                <i class="codicon codicon-send" /> Ask
              </button>
            )}
          </div>
          <div class="hint" ref={end}>
            {ask ? `${modelName(ask.model)} answers` : 'A fast model answers'}, reading the code and git only. Closing the ticket forgets the chat.
          </div>
        </div>
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
  resume: 'debug-continue',
};

const FIX_TIP: Record<ReviewFix, string> = {
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

const PAUSE_TIP = 'Stops it now and keeps its chat; its work stays in the worktree as it is. Resume goes on in the same chat';
const STOP_TIP = 'Ends it (its chat is kept): resume it later, or hand the work to a new agent';

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The ticket's discussion with its agent (BL-45): while the agent replies, and when it says the ticket is ready. */
function DiscussPanel({ ticket }: { ticket: TicketView }) {
  const s = ticket.shaping!;
  if (s.held && !s.running) {
    return (
      <div class="review-panel waiting">
        <i class="codicon codicon-debug-pause" />
        <span class="review-text">
          <strong>Discussion</strong> You {s.held} {s.agent}. Its chat is kept: Resume, or write a comment, and it goes on there.
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
            <button class="button" onClick={() => send({ type: 'accept' })}>
              <i class="codicon codicon-check" /> Accept
            </button>
          ) : (
            <ActionButton class="button" message={{ type: 'start', agent: true }} working="Starting…">
              <i class="codicon codicon-play" /> Start
            </ActionButton>
          )}
          <ActionButton class="button secondary" message={{ type: 'keepDiscussing' }} working="Continuing…" title="Dismisses this; the discussion goes on with your next comment">
            Keep discussing
          </ActionButton>
        </>
      )}
    </div>
  );
}

/** A start that waits for a free agent slot or for free memory, with Prioritize (it starts now, above the limit). */
function QueuedPanel({ queued }: { queued: QueuedView }) {
  return (
    <div class="review-panel waiting">
      <i class="codicon codicon-clock" />
      <span class="review-text">
        {queuedNeed(queued).line}
        {queued.reason === 'slot' ? `: ${queued.running} of ${queued.limit} agents running.` : '.'}
      </span>
      <button class="button secondary" onClick={() => send({ type: 'prioritize' })} title="Starts it now, above the limit, or pauses a running agent to make room">
        <i class="codicon codicon-arrow-up" /> Prioritize
      </button>
    </div>
  );
}

/** The busy agents the review panel doesn't show (started by hand, not by the loop). */
function outsideAgents(ticket: TicketView): TicketView['agents'] {
  const r = ticket.review;
  const own = r?.state === 'reviewing' ? r.reviewerSession : r?.state === 'working' || r?.state === 'revising' ? r.implementerSession : undefined;
  // The discussion's agent shows in its own panel.
  return ticket.agents.filter((a) => a.runs && a.id !== own && !(ticket.shaping?.running && a.agent === ticket.shaping.agent));
}

/**
 * An agent working on the ticket outside the review loop (started by hand): one in a terminal can be paused and
 * stopped here; one in Claude Code's panel only there (its chat opens).
 */
function AgentStatus({ agent: a }: { agent: TicketView['agents'][number] }) {
  return (
    <div class="review-panel working">
      <i class="codicon codicon-hubot pulse" />
      <span class="review-text">
        <strong>Agent</strong>{' '}
        {a.runs === 'panel'
          ? `${a.agent} is working in Claude Code's panel. It can't be paused or stopped from here: stop it in its chat (Esc, or its stop button).`
          : `${a.agent} is working${a.runs === 'terminal' ? ' in a terminal' : ' without a window'}; it reports below.`}
      </span>
      {a.runs === 'panel' ? (
        <ActionButton class="button secondary" message={{ type: 'openChat', key: a.key, id: a.id }} working="Opening…" title="Open its chat in Claude Code">
          <i class="codicon codicon-comment-discussion" /> Open Chat
        </ActionButton>
      ) : (
        <>
          <ActionButton class="button secondary" message={{ type: 'agent', action: 'pause', session: a.id }} working="Pausing…" title={PAUSE_TIP}>
            <i class="codicon codicon-debug-pause" /> Pause
          </ActionButton>
          <ActionButton class="button secondary" message={{ type: 'agent', action: 'stop', session: a.id }} working="Stopping…" title={STOP_TIP}>
            <i class="codicon codicon-debug-stop" /> Stop
          </ActionButton>
        </>
      )}
    </div>
  );
}

/** Where the review loop is: who reviews, the verdict; stop it, or start it again. */
function ReviewPanel({ ticket }: { ticket: TicketView }) {
  const r = ticket.review!;
  const active = r.state === 'reviewing' || r.state === 'revising' || r.state === 'asking' || r.state === 'working' || r.state === 'paused';
  // Whose turn it is, said in words with the reviewer and the implementer named, and what the user can do now.
  const turn = turnOf({ status: ticket.item.status, review: r });
  const said = turn && turnSentence(turn, r);
  const pause =
    r.state === 'paused' && r.paused?.byUser
      ? `(${when(r.paused.byUser)}) Its chat is kept, and its work in the worktree as it was.`
      : r.state === 'paused' && r.paused?.for
      ? `${r.paused.agent} is paused for ${r.paused.for}: its slot went to a prioritized start. It resumes from its chat when a slot frees.`
      : r.state === 'paused' && r.paused
      ? `${r.paused.agent} stopped on Claude's usage limit; it goes on by itself ${r.paused.known ? 'when it resets' : 'at'} ${when(r.paused.until)}.`
      : r.state === 'stopped' && r.stop?.kind === 'user' && r.stop.at
      ? `(${when(r.stop.at)})`
      : undefined;
  // The agent the user paused or stopped: it can be resumed in its chat.
  const held = heldBy(r);
  const running = r.state === 'reviewing' || r.state === 'revising' || r.state === 'working';
  const autopilot = r.state === 'working' || (r.state === 'paused' && r.paused?.phase === 'work' && (r.autopilot || r.byHand) && !turn);
  const [icon, cls, label, text, todo] = autopilot
    ? r.byHand
      ? ['play', 'working', 'Working', pause ?? `${r.implementer ?? 'the implementer'} is working on it (you started it, without a window); it reports below`, undefined]
      : ['rocket', 'working', 'Autopilot', pause ?? `${r.implementer ?? 'the implementer'} is working on it (the autopilot started it); it reports below`, undefined]
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
        {running && !yours && (
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
          <ActionButton class="button secondary" message={{ type: 'stopReview' }} working="Stopping…" title={running ? STOP_TIP : 'Stops the review and the handoffs'}>
            <i class="codicon codicon-debug-stop" /> Stop
          </ActionButton>
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
            {ticket.canMerge && <MergeButton into={ticket.mergeInto ?? 'main'} progress={ticket.mergeProgress} />}
          </>
        )}
      </div>
      {ticket.canMerge && ticket.mergeStop && !active && <MergeStop stop={ticket.mergeStop} />}
      {ticket.canMerge && ticket.mergeQueue && !active && <QueuePlace queue={ticket.mergeQueue} />}
    </>
  );
}

/** The ticket without its merge's CI stop once its CI shows other runs on the tip it stopped on (a re-run). */
function withCiStop(ticket: TicketView, ci: TicketCiView | undefined): TicketView {
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
function MergeStop({ stop }: { stop: CiStop }) {
  if (stop.kind === 'moved')
    return (
      <div class="merge-stop">
        <i class="codicon codicon-warning" />
        <span class="review-text">
          <strong>Not merged:</strong> {stop.base} has moved on since <code>{stop.branch}</code> took it in, so CI checked another tree than the merge's. Update
          from {capitalize(stop.base)}, then merge when CI passes.
        </span>
        <ActionButton class="button" message={{ type: 'updateFromMain' }} working="Updating…" title={`Merges ${stop.base} into the branch, which is pushed, and CI runs again`}>
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
function QueuePlace({ queue }: { queue: NonNullable<TicketView['mergeQueue']> }) {
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
function MergeButton({ into, progress }: { into: string; progress?: TicketView['mergeProgress'] }) {
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
function MergingPanel({ ticket }: { ticket: TicketView }) {
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
        <button class="button secondary" onClick={() => send({ type: 'mergeCancel' })} title="Stops its agent and removes the temporary worktree; nothing changes">
          <i class="codicon codicon-close" /> Cancel
        </button>
        {actions.includes('resolve') && (
          <button
            class="button"
            onClick={() => send({ type: 'mergeResolve' })}
            title={
              checks
                ? 'An agent fixes the merge, given the failing output and the tickets of both sides: it keeps both intents (or asks you here), and reports here for you to approve'
                : "An agent resolves the conflicts, keeping both sides' intent, and reports here for you to approve"
            }
          >
            <i class="codicon codicon-hubot" /> {checks ? 'Fix with Agent' : 'Resolve with Agent'}
          </button>
        )}
        {actions.includes('recheck') && (
          <button
            class="button secondary"
            onClick={() => send({ type: 'mergeRecheck' })}
            title="Runs the checks again on the merge as it is (a failure that was only a loaded machine's goes away): passing, the base branch moves to the merge"
          >
            <i class="codicon codicon-refresh" /> Run the Checks Again
          </button>
        )}
        {actions.includes('approve') && (
          <button class={`button${m.state === 'resolved' ? '' : ' secondary'}`} onClick={() => send({ type: 'mergeApprove' })} title="Runs the checks on the merge, then moves the base branch to it">
            <i class="codicon codicon-check" /> {checks ? 'Approve Fix' : 'Approve Resolution'}
          </button>
        )}
      </div>
      {checks && (
        <details class="merge-output" open={m.state === 'failed'}>
          <summary>The checks' output (its end; all of it is in the terminal)</summary>
          <pre>{checks.output.trim() || '(no output)'}</pre>
        </details>
      )}
    </>
  );
}

/** A merged ticket: where it went, and pushing the base branch (asks first). */
function MergedPanel({ ticket }: { ticket: TicketView }) {
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
        <button class="button secondary" onClick={() => send({ type: 'push' })} title={`Pushes ${u.base} to ${u.remote} (asks first)`}>
          <i class="codicon codicon-cloud-upload" /> Push…
        </button>
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
          <ActionButton
            key={c.hash}
            class="work-row commit nested"
            message={{ type: 'openCommit', hash: c.hash }}
            working="Opening…"
            title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show what it changed`}
          >
            <span class="hash">{c.short}</span>
            <span class="work-main subject">{c.subject}</span>
            <span class="muted work-when">
              {c.author} · {ago(c.date)}
            </span>
          </ActionButton>
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

/**
 * How the work stands against main (BL-55): its branches that conflict with main, and the tickets it waits for
 * ("Depends on: BL-12" in its description). Update from Main merges main into its branch (its agent resolves conflicts).
 */
function MainState({ ticket }: { ticket: TicketView }) {
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
            <button
              class="text-button main-note-action"
              onClick={() => send({ type: 'updateFromMain' })}
              title={`Hands merging ${update.base} into the branch to its agent, which resolves the conflicts and runs the checks`}
            >
              <i class="codicon codicon-sync" /> Update from {capitalize(update.base)}
            </button>
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
          {ticket.updateFromMain && (
            <button
              class="text-button work-head-action"
              onClick={() => send({ type: 'updateFromMain' })}
              title={`Merges ${ticket.updateFromMain.base} into its branch; when that conflicts, its agent does it and resolves the conflicts`}
            >
              <i class="codicon codicon-sync" /> Update from {capitalize(ticket.updateFromMain.base)}
            </button>
          )}
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
            <ActionButton class="text-button work-action" message={{ type: 'checkout', branch: b }} working="Creating the worktree…" title="Create a worktree for this branch">
              <i class="codicon codicon-add" /> Worktree
            </ActionButton>
          </div>
        ))}
        <div class="work-head">
          <i class="codicon codicon-git-commit" /> Commits <span class="count">{ticket.commits.length}</span>
          {ticket.canCleanUp && (
            <ActionButton
              class="text-button work-head-action"
              message={{ type: 'cleanUp' }}
              working="Starting…"
              title="Rewrite the branch's commits into a clean history (an agent with you, or yourself). The old history is kept, and shown here."
            >
              <i class="codicon codicon-wand" /> Clean Up History…
            </ActionButton>
          )}
        </div>
        {!ticket.commits.length && <div class="work-empty muted">None yet. Commits on its branches, or that mention {ticket.item.id}, show here.</div>}
        {commits.map((c) => (
          <ActionButton
            key={c.hash}
            class="work-row commit"
            message={{ type: 'openCommit', hash: c.hash }}
            working="Opening…"
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
          </ActionButton>
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

/** Every agent on the ticket now, in full: its state, how long it has run, its worktree, what it last reported. */
function ActiveAgents({ ticket, agents }: { ticket: TicketView; agents: TicketView['agents'] }) {
  // How long each has run goes on counting between updates.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section class="block active-agents">
      <div class="block-head">
        <h2>Active agents</h2>
      </div>
      <div class="agents">
        {agents.map((a) => {
          const state = a.held === 'paused' ? { label: 'Paused', cls: 'waiting' } : a.state === 'waiting-for-input' ? CHAT_STATE['waiting-for-input'] : CHAT_STATE.working;
          const report = lastReport(ticket.activity, a.id);
          return (
            <div key={a.id} class={`active-agent ${state.cls}`}>
              <div class="active-agent-head">
                <span class="chat-icon small">
                  <i class="codicon codicon-hubot" />
                  <span class={`dot ${state.cls}`} />
                </span>
                <span class="agent-name">{a.agent}</span>
                <span class={`state ${state.cls}`}>{state.label}</span>
                <span class="muted agent-meta" title={`Started ${new Date(a.started).toLocaleString()}`}>
                  <i class="codicon codicon-watch" /> running {runningFor(a.started)}
                </span>
                <span class="muted agent-meta active-agent-worktree" title={`Worktree: ${a.key}`}>
                  <i class="codicon codicon-git-branch" /> {a.branch}
                </span>
                <ActionButton class="button secondary" message={{ type: 'openChat', key: a.key, id: a.id }} working="Opening…" aria-label={`Open ${a.agent}'s chat`} title="Open this agent's chat in Claude Code">
                  <i class="codicon codicon-comment-discussion" /> Open Chat
                </ActionButton>
              </div>
              {report ? (
                <div class="active-agent-report">
                  <span class="muted">Last report · {report.date}</span>
                  <Rendered html={report.html} empty="" />
                </div>
              ) : (
                <div class="active-agent-report muted">No report yet.</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Every agent that worked on the ticket: its chat, its state, how much it reported. */
function Agents({ ticket }: { ticket: TicketView }) {
  // What its agents re-read in all (BL-76): most of what a ticket costs.
  const reRead = ticket.agents.reduce((n, a) => n + (a.tokens?.reRead ?? 0), 0);
  return (
    <section class="block">
      <div class="block-head">
        <h2>Agents</h2>
        {reRead > 0 && (
          <span class="muted" title="The tokens its agents re-read from their context, in all: most of what a ticket costs (each turn re-reads the whole chat)">
            {formatTokens(reRead)} tokens re-read
          </span>
        )}
      </div>
      <div class="agents">
        {ticket.agents.map((a) => {
          const state = a.held ? { label: a.held === 'paused' ? 'Paused' : 'Stopped', cls: 'waiting' } : (CHAT_STATE[a.state] ?? CHAT_STATE.ended);
          return (
            <div key={a.id} class={`agent-row ${state.cls}`}>
              <button class="agent-open" onClick={() => send({ type: 'openChat', key: a.key, id: a.id })} title="Open this chat in Claude Code">
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
                {a.tokens && (
                  <span class="muted agent-meta" title={a.tokens.tip}>
                    <i class="codicon codicon-pulse" /> {a.tokens.label} re-read
                  </span>
                )}
                <span class="muted agent-meta">
                  {a.reports} report{a.reports === 1 ? '' : 's'} · {ago(a.updated)}
                </span>
                {a.runs === 'panel' && (
                  <span class="muted agent-meta" title="Claude Code's panel can't be paused or stopped from outside: stop it in its chat (Esc, or its stop button)">
                    in Claude Code's panel
                  </span>
                )}
                <i class="codicon codicon-arrow-right open-arrow" />
              </button>
              {(a.held || (a.runs && a.runs !== 'panel')) && (
                <span class="agent-actions">
                  {a.held ? (
                    <ActionButton class="icon-button" message={{ type: 'agent', action: 'resume', session: a.id }} working="Resuming…" aria-label={`Resume ${a.agent}`} title={FIX_TIP.resume}>
                      <i class="codicon codicon-debug-continue" />
                    </ActionButton>
                  ) : (
                    <ActionButton class="icon-button" message={{ type: 'agent', action: 'pause', session: a.id }} working="Pausing…" aria-label={`Pause ${a.agent}`} title={PAUSE_TIP}>
                      <i class="codicon codicon-debug-pause" />
                    </ActionButton>
                  )}
                  {a.held !== 'stopped' && (
                    <ActionButton class="icon-button" message={{ type: 'agent', action: 'stop', session: a.id }} working="Stopping…" aria-label={`Stop ${a.agent}`} title={STOP_TIP}>
                      <i class="codicon codicon-debug-stop" />
                    </ActionButton>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * What an agent needs from the user: its text, and its questions. Unanswered questions (local items) are answered by
 * clicking: a choice (its recommendation preselected) or Other…; one Send posts the answers as the user's comment, and
 * the agent goes on from there. Answered ones, and those of tracker-linked items, show what was chosen, read-only.
 */
function Needs({ report, name, live }: { report: ReportView; name: string; live: boolean }) {
  const answered = report.answer !== undefined;
  const interactive = live && !answered && report.questions.length > 0;
  const [answers, setAnswers] = useState<Answer[]>(() => report.questions.map(defaultAnswer));
  const given = answered ? answersIn(report.questions, report.answer!) : [];
  const shown = interactive ? answers : report.questions.map((q, i) => (answered ? answerFromText(q, given[i] ?? '') : { picked: [], other: '' }));
  const update = (qi: number, change: (a: Answer) => Answer) => setAnswers((all) => all.map((a, i) => (i === qi ? change(a) : a)));
  const texts = report.questions.map((q, i) => answerOf(q, answers[i]));
  const ready = interactive && texts.every(Boolean);
  const submit = () => {
    if (ready) sendComment(answerComment(report.questions.map((question, i) => ({ question, answer: texts[i] }))));
  };
  return (
    <div class={`needs${answered ? ' answered' : ''}`}>
      {report.needs && (
        <>
          <div class="needs-line">
            <i class="codicon codicon-question" /> <strong>Needs from you:</strong>
          </div>
          <Rendered html={report.needs} empty="" />
        </>
      )}
      {answered && <div class="muted">Answered.</div>}
      {report.questions.map((q, qi) => {
        const a = shown[qi];
        const other = q.options.length;
        const type = q.kind === 'several' ? 'checkbox' : 'radio';
        return (
          <fieldset class="question" key={qi}>
            <legend>{q.text}</legend>
            {q.kind === 'text' ? (
              interactive ? (
                <MarkdownBox
                  value={a.other}
                  setValue={(text) => update(qi, (x) => ({ ...x, other: text }))}
                  placeholder="Your answer (Markdown)"
                  label={`Your answer to: ${q.text}`}
                  onSubmit={submit}
                  images={false}
                  minRows={2}
                  autoFocus={qi === 0}
                />
              ) : (
                <div class="answer-text">{a.other}</div>
              )
            ) : (
              <>
                {q.options.map((o, i) => (
                  <label class="choice" key={i}>
                    <input
                      type={type}
                      name={`${name}-${qi}`}
                      checked={a.picked.includes(i)}
                      disabled={!interactive}
                      onChange={() => update(qi, (x) => choose(q, x, i))}
                    />
                    <span>{o.text}</span>
                    {o.recommended && <span class="recommended">recommended</span>}
                  </label>
                ))}
                {q.kind !== 'yesno' && (
                  <label class="choice">
                    <input
                      type={type}
                      name={`${name}-${qi}`}
                      checked={a.picked.includes(other)}
                      disabled={!interactive}
                      onChange={() => update(qi, (x) => choose(q, x, other))}
                    />
                    <span>Other…</span>
                  </label>
                )}
                {q.kind !== 'yesno' &&
                  a.picked.includes(other) &&
                  (interactive ? (
                    <MarkdownBox
                      value={a.other}
                      setValue={(text) => update(qi, (x) => ({ ...x, other: text }))}
                      placeholder="Your answer (Markdown)"
                      label={`Your answer to: ${q.text}`}
                      onSubmit={submit}
                      images={false}
                      minRows={2}
                      autoFocus
                    />
                  ) : (
                    <div class="answer-text">{a.other}</div>
                  ))}
              </>
            )}
          </fieldset>
        );
      })}
      {interactive && (
        <div class="actions-row">
          <button class="button" disabled={!ready} onClick={submit} title="Posts the answers as your comment: the agent goes on from there">
            {report.questions.length > 1 ? 'Send Answers' : 'Send'}
          </button>
        </div>
      )}
    </div>
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

const TABS: Array<{ kind?: EntryKind; label: string }> = [{ label: 'All' }, { kind: 'comment', label: 'Comments' }, { kind: 'agent', label: 'Agent Reports' }];

const EMPTY: Record<string, string> = {
  all: 'No comments or reports yet. Agents report here as they work.',
  comment: 'No comments yet.',
  agent: 'No agent reports yet. Start an agent: it reports here as it works.',
};

/** A row of the feed: an entry, or a commit. */
type FeedRow = TicketView['activity'][number] | { commit: TicketView['commits'][number] };

const feedRound = (f: FeedRow): RoundInfo => ('commit' in f ? { part: 'round' } : entryRound(f));

/** A feed row's key: a commit's hash, or an entry's place in the ticket's activity (which only grows at the end). */
const rowKey = (f: FeedRow, ticket: TicketView) => ('commit' in f ? `commit-${f.commit.hash}` : `entry-${ticket.activity.indexOf(f)}`);

/** One row of the feed: a commit, or an entry (a comment, an agent's report, a note). */
function FeedRowView({ f, ticket, onFold, nest }: { f: FeedRow; ticket: TicketView; onFold?: () => void; nest?: boolean }) {
  if ('commit' in f) {
    const c = f.commit;
    return (
      <li class="entry kind-commit">
        <ActionButton
          class="commit-line"
          message={{ type: 'openCommit', hash: c.hash }}
          working="Opening…"
          title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
        >
          <i class="codicon codicon-git-commit" />
          <span class="hash">{c.short}</span>
          <span class="subject">{c.subject}</span>
          {c.branches[0] && <span class="branch-tag">{c.branches[0]}</span>}
          <span class="muted">
            {c.author} · {ago(c.date)}
          </span>
        </ActionButton>
      </li>
    );
  }
  const e = f;
  const kind = kindOf(e.author);
  const agentChat = kind === 'agent' && e.chat && !('pending' in e.chat) ? e.chat : undefined;
  // Its replies show under it, one level deep (BL-126): a top-level entry's, in the conversation.
  const replies = nest ? repliesTo(e, ticket) : [];
  return (
    <li class={`entry kind-${kind}${e.reply ? ' reply' : ''}`} data-entry-key={e.key}>
      {e.reply && <ReplyLine e={e} ticket={ticket} />}
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
          <ActionButton class="text-button post-entry" message={{ type: 'postEntry', key: e.key! }} working="Posting…" title="Shows what will be posted and asks first">
            <i class="codicon codicon-comment-unresolved" /> Post to {ticket.postTargets.length === 1 ? ticket.postTargets[0] : 'an Issue'}…
          </ActionButton>
        )}
        {!ticket.remote && e.anchor && kind !== 'history' && (
          <button
            class="text-button reply-entry"
            onClick={() => window.dispatchEvent(new CustomEvent<ActivityEntry>(REPLY_TO, { detail: e }))}
            title="Reply to this entry: your comment shows under it"
          >
            <i class="codicon codicon-reply" /> Reply
          </button>
        )}
        {onFold && (
          <button class="text-button fold-entry" aria-expanded={true} onClick={onFold}>
            <i class="codicon codicon-chevron-up" /> Fold
          </button>
        )}
      </div>
      {e.report ? (
        <>
          <Rendered html={e.report.summary} empty="" />
          {/* Its pictures, videos and diagrams lead it (BL-114): the text they belong to stays in Details. */}
          {e.report.media && (
            <div class="report-media">
              <Rendered html={e.report.media} empty="" />
            </div>
          )}
          {e.report.asks && <Needs report={e.report} name={e.key ?? `${e.date}${e.author}`} live={!ticket.remote} />}
          {e.report.details && (
            <details class="report-details">
              <summary>Details</summary>
              <Rendered html={e.report.details} empty="" />
            </details>
          )}
        </>
      ) : (
        <Rendered html={e.html} empty="" />
      )}
      {kind === 'history' && e.chat && <ChatCard chat={e.chat} />}
      {replies.length > 0 && (
        <ol class="replies">
          {replies.map((r) => (
            <FeedRowView key={rowKey(r, ticket)} f={r} ticket={ticket} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** The replies grouped under a top-level entry (BL-126): in the conversation, by anyone but Flotilla. */
function repliesTo(e: ActivityEntry, ticket: TicketView): ActivityEntry[] {
  const i = ticket.activity.indexOf(e);
  return ticket.activity.filter((r) => r.root === i && kindOf(r.author) !== 'history');
}

/** Whether an entry shows under its top-level entry, not on its own: a reply to an entry of the conversation. */
const nested = (e: ActivityEntry, ticket: TicketView) =>
  e.root !== undefined && kindOf(e.author) !== 'history' && !!ticket.activity[e.root] && kindOf(ticket.activity[e.root].author) !== 'history';

/** "↩ reply to You, 16:04" above a reply: a click goes to the entry it answers (when it's still there). */
function ReplyLine({ e, ticket }: { e: ActivityEntry; ticket: TicketView }) {
  const r = e.reply!;
  const parent = ticket.activity.find((p) => p.anchor === r.to);
  const day = r.date.slice(0, 10) === e.date.slice(0, 10) ? r.date.slice(11) : r.date;
  const label = parent ? `reply to ${byName(parent)}${day ? `, ${day}` : ''}` : r.label.replace(/^Reply/, 'reply') || 'reply';
  return parent?.key ? (
    <button class="reply-to" onClick={() => showEntry(parent.key!)} title="Go to the entry it answers">
      ↩ {label}
    </button>
  ) : (
    <div class="reply-to" title={parent ? undefined : 'The entry it answers is no longer in the ticket'}>
      ↩ {label}
    </div>
  );
}

/** A folded report's media (BL-114), beside its line: a click opens one in the viewer, and the entry stays folded. */
function MediaStrip({ e }: { e: ActivityEntry }) {
  const thumbs = e.thumbs!;
  const open = (at: number) =>
    openMedia(
      thumbs.map((t) => ({ ...t, name: t.alt ?? (t.kind === 'diagram' ? 'Diagram' : (t.src ?? '').split(/[/?#]/).filter(Boolean).at(-1) ?? ''), author: e.author, date: e.date, entryKey: e.key })),
      at,
    );
  return (
    <ul class="media-strip">
      {thumbs.map((t, i) => (
        <li key={i}>
          <button class="media-thumb" onClick={() => open(i)} title={`${t.alt ?? (t.kind === 'diagram' ? 'A diagram' : '')}\nClick to open it large`.trim()}>
            {t.kind === 'diagram' ? (
              <Diagram code={t.code ?? ''} label={t.alt ?? 'A diagram'} class="media-thumb-diagram" />
            ) : t.kind === 'video' ? (
              <>
                {/* Its first frame; it doesn't play here. */}
                <video src={t.src} preload="metadata" muted tabIndex={-1} />
                <i class="codicon codicon-play-circle play-mark" />
              </>
            ) : (
              <img src={t.src} alt={t.alt ?? ''} loading="lazy" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A review's rounds folded into one line ("Reviewed by Flux-3 in 2 rounds → approved"); a click shows them, in order. */
function RoundFoldLine({ fold, ticket }: { fold: RoundFold<FeedRow>; ticket: TicketView }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // "Show in activity" (BL-110) for an entry in it opens it.
    const show = (e: Event) => fold.items.some((f) => !('commit' in f) && f.key === (e as CustomEvent<string>).detail) && setOpen(true);
    window.addEventListener(SHOW_ENTRY, show);
    return () => window.removeEventListener(SHOW_ENTRY, show);
  }, [fold]);
  return (
    <li class="entry kind-review">
      <button
        class="review-fold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? 'Hides the reviews and changes' : 'Shows the reviews and changes, in order'}
      >
        <i class={`codicon codicon-${open ? 'chevron-down' : 'chevron-right'}`} />
        <i class="codicon codicon-eye" />
        <span>{foldTitle(fold)}</span>
      </button>
      {open && (
        <ol class="fold-items">
          {fold.items.map((f) => (
            <FeedRowView key={rowKey(f, ticket)} f={f} ticket={ticket} nest />
          ))}
        </ol>
      )}
    </li>
  );
}

/** What the link under a ticket in review without a run block puts in the comment box: a request to the agent. */
const ASK_FOR_RUN =
  'Please end your report with a run block: a fenced block with the info string `run`, and the commands that try the work (or a `launch`, `task` or `open` block), so it can be run from here.';

/** Flotilla's notes and the commits, in time order: what happened, behind "Show activity". */
function Timeline({ ticket }: { ticket: TicketView }) {
  const notes = ticket.activity.filter((e) => kindOf(e.author) === 'history');
  const rows = withCommits(notes, ticket.commits);
  if (!rows.length) return <div class="empty-text">Nothing has happened yet.</div>;
  return (
    <ol class="timeline">
      {rows.map((f, i) => {
        if ('commit' in f) {
          const c = f.commit;
          return (
            <li key={c.hash} class="timeline-row">
              <ActionButton
                class="timeline-item commit"
                message={{ type: 'openCommit', hash: c.hash }}
                working="Opening…"
                title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()}\nClick to show it in its worktree’s history`}
              >
                <i class="codicon codicon-git-commit" />
                <span class="hash">{c.short}</span>
                <span class="timeline-text">{c.subject}</span>
                <span class="muted">{ago(c.date)}</span>
              </ActionButton>
            </li>
          );
        }
        const e = f;
        const chat = e.chat && !('pending' in e.chat) ? e.chat : undefined;
        return (
          <li key={`${e.date}${i}`} class="timeline-row">
            <span class="timeline-item">
              <span class="muted">{e.date}</span>
              <span class="timeline-text">{summaryOf(e.body) ?? ''}</span>
            </span>
            {chat && (
              <button
                class="chat-chip"
                onClick={() => send({ type: 'openChat', key: chat.key, id: chat.id })}
                title={`Open the chat "${chat.title}" in Claude Code`}
              >
                <i class="codicon codicon-comment-discussion" />
                <span class="chat-chip-title">{chat.title}</span>
              </button>
            )}
            {e.chat && 'pending' in e.chat && <ChatCard chat={e.chat} />}
          </li>
        );
      })}
    </ol>
  );
}

function Activity({ ticket }: { ticket: TicketView }) {
  const [comment, setComment] = useState('');
  // The entry the comment box replies to (BL-126).
  const [replyTo, setReplyTo] = useState<ActivityEntry | undefined>(undefined);
  const [tab, setTab] = useState<EntryKind | undefined>(undefined);
  const [timeline, setTimeline] = useState(ticket.showActivity);
  // The entries (by their place in the activity) the user opened: all but the latest report fold to a line.
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  useEffect(() => setTimeline(ticket.showActivity), [ticket.showActivity]);
  const toggleOpened = (i: number) =>
    setOpened((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleTimeline = () => {
    setTimeline(!timeline);
    send({ type: 'showActivity', shown: !timeline });
  };
  useEffect(() => {
    // "Show in activity" (BL-110): the entry opens, with its details, and shows in the middle for a moment.
    const show = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const i = ticket.activity.findIndex((e) => e.key === key);
      if (i < 0) return;
      setTab(undefined);
      // A reply's top-level entry opens with it (BL-126).
      const root = ticket.activity[i].root;
      setOpened((s) => new Set(s).add(i).add(root ?? i));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const li = document.querySelector<HTMLElement>(`.feed [data-entry-key="${CSS.escape(key)}"]`);
          if (!li) return;
          for (const d of li.querySelectorAll('details')) if (d.querySelector('img, video, [data-diagram], code.language-mermaid')) d.open = true;
          // A diagram's "Show in activity" (BL-136) goes to the diagram in it.
          const n = shownDiagram(key);
          ((n !== undefined ? diagramsIn(li)[n] : undefined) ?? li).scrollIntoView({ behavior: 'smooth', block: 'center' });
          li.classList.add('flash');
          setTimeout(() => li.classList.remove('flash'), 1600);
        }),
      );
    };
    window.addEventListener(SHOW_ENTRY, show);
    return () => window.removeEventListener(SHOW_ENTRY, show);
  }, [ticket.activity]);
  useEffect(() => {
    const reply = (event: Event) => {
      setReplyTo((event as CustomEvent<ActivityEntry>).detail);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.comment-box textarea')?.focus());
    };
    window.addEventListener(REPLY_TO, reply);
    return () => window.removeEventListener(REPLY_TO, reply);
  }, []);
  // The entry replied to, as the ticket has it now (gone when it was removed).
  const replying = replyTo && ticket.activity.find((e) => e.anchor === replyTo.anchor);
  const sending = useSending();
  useEffect(() => {
    const listener = (m: TicketWebviewMessage, failed: boolean) => {
      // It didn't post: what was written goes back into the box, so nothing is lost.
      if (m.type === 'comment' && failed) setComment((draft) => (draft.trim() ? draft : m.text));
    };
    doneListeners.add(listener);
    return () => void doneListeners.delete(listener);
  }, []);
  // Once the host has the comment (an entry after `at`, by the same author), it's no longer sent: it's the entry.
  const unconfirmed = sending.filter((p) => !ticket.activity.slice(p.at).some((e) => e.author === 'You' && e.body.trim() === p.text.trim()));
  const changesBusy = useWorking({ type: 'userReview', verdict: 'changes', text: '' });
  const approveBusy = useWorking({ type: 'userReview', verdict: 'approved', text: '' });
  const post = () => {
    if (!comment.trim()) return;
    sendComment(comment, replying?.anchor);
    setComment('');
    setReplyTo(undefined);
    if (tab && tab !== 'comment') setTab(undefined);
  };
  const review = (verdict: 'approved' | 'changes') => {
    act({ type: 'userReview', verdict, text: comment }, 'Sending…');
    setComment('');
    if (tab && tab !== 'comment') setTab(undefined);
  };
  const asking = ticket.review?.state === 'asking' ? (ticket.review.implementer ?? 'The agent') : undefined;
  // A local item with work to review: the user can review it here, as in a pull request.
  const reviewable = !ticket.remote && ticket.canReview && ticket.item.status !== 'done';
  // A ticket in review (or approved) runs its latest run block from here, next to Approve and Request Changes.
  const showRun = !ticket.remote && (ticket.item.status === 'review' || ticket.review?.state === 'approved');
  // It goes in the comment box, after a draft. Request Changes sends it to the agent: a Comment is only a note.
  const askForRun = () => {
    setComment((draft) => (draft.trim() ? `${draft.trimEnd()}\n\n${ASK_FOR_RUN}` : ASK_FOR_RUN));
    document.querySelector<HTMLTextAreaElement>('.comment-box textarea')?.focus();
  };
  // In All, a reply shows under its top-level entry (BL-126); a tab shows each entry of its kind on its own.
  const inConversation = (e: ActivityEntry) => kindOf(e.author) !== 'history' && (tab ? kindOf(e.author) === tab : !nested(e, ticket));
  // In All, a review's rounds fold into one line (rounds.ts). They're found with Flotilla's notes ("Review round 2: …"),
  // which then stay in the timeline: a fold shows the reviews and revisions.
  const groups: Array<FeedGroup<FeedRow>> = tab
    ? ticket.activity.filter(inConversation).map((item) => ({ item }))
    : foldRounds<FeedRow>(ticket.activity, feedRound, ticket.review && { state: ticket.review.state, reviewer: ticket.review.reviewer })
        .map((g) => ('fold' in g ? { fold: { ...g.fold, items: g.fold.items.filter((f) => !('commit' in f) && inConversation(f)) } } : g))
        .filter((g) => ('fold' in g ? g.fold.items.length > 0 : !('commit' in g.item) && inConversation(g.item)));
  // Notes and commits are the timeline; comments and reports are the conversation. The latest agent's report in the
  // feed is open (rounds.ts says which), older ones are folded to a line each (opened by a click).
  const folded = new Set(groups.flatMap((g) => ('fold' in g ? g.fold.items : [])));
  const latest = openEntry(ticket.activity, (e) => !folded.has(e) && (!nested(e, ticket) || !folded.has(ticket.activity[e.root!])));
  return (
    <section class="block">
      <div class="block-head">
        <h2>Activity</h2>
      </div>
      <div class="tabs" role="tablist" aria-label="Show">
        {TABS.map((t) => {
          const count = ticket.activity.filter((e) => kindOf(e.author) !== 'history' && (!t.kind || kindOf(e.author) === t.kind)).length;
          return (
            <button key={t.label} role="tab" aria-selected={tab === t.kind} onClick={() => setTab(t.kind)}>
              {t.label}
              {count > 0 && <span class="count">{count}</span>}
            </button>
          );
        })}
      </div>
      {!groups.length && !unconfirmed.length && !ticket.loading && <div class="empty-text">{EMPTY[tab ?? 'all']}</div>}
      <ol class="feed">
        {groups.map((g) => {
          if ('fold' in g) return <RoundFoldLine key={rowKey(g.fold.items[0], ticket)} fold={g.fold} ticket={ticket} />;
          const e = g.item as TicketView['activity'][number];
          const i = ticket.activity.indexOf(e);
          const replies = tab ? 0 : repliesTo(e, ticket).length;
          // The latest agent's entry is open, and so is the entry it replies to.
          const holdsLatest = !!latest && latest.root === i && nested(latest, ticket);
          if (e !== latest && !holdsLatest && !opened.has(i)) {
            return (
              <li key={i} class={`entry folded kind-${kindOf(e.author)}`} data-entry-key={e.key}>
                <button class="entry-fold" aria-expanded={false} onClick={() => toggleOpened(i)} title="Open this entry">
                  <i class="codicon codicon-chevron-right" />
                  <strong>{entryAgent(e.author) ?? (e.author || 'Note')}</strong>
                  {e.date && <span class="muted">{e.date}</span>}
                  <span class="fold-first">{summaryOf(e.body) ?? ''}</span>
                  {replies > 0 && (
                    <span class="reply-count">
                      {replies} repl{replies === 1 ? 'y' : 'ies'}
                    </span>
                  )}
                </button>
                {!!e.thumbs?.length && <MediaStrip e={e} />}
              </li>
            );
          }
          return <FeedRowView key={i} f={e} ticket={ticket} nest={!tab} onFold={e !== latest && !holdsLatest ? () => toggleOpened(i) : undefined} />;
        })}
        {(!tab || tab === 'comment') &&
          unconfirmed.map((p, i) => (
            <li key={`sending-${i}`} class="entry kind-comment sending">
              <div class="entry-head">
                <i class="codicon codicon-account" />
                <strong>You</strong>
                <span class="muted">{p.date}</span>
                <WorkingTag label="Sending…" />
              </div>
              <div class="sending-body">{p.text}</div>
            </li>
          ))}
      </ol>
      <button class="text-button activity-toggle" aria-expanded={timeline} onClick={toggleTimeline}>
        <i class={`codicon codicon-chevron-${timeline ? 'down' : 'right'}`} /> {timeline ? 'Hide activity' : 'Show activity'}
      </button>
      {timeline && <Timeline ticket={ticket} />}
      <div class="comment-box">
        {replying && (
          <div class="replying">
            <i class="codicon codicon-reply" /> Replying to <strong>{byName(replying)}</strong>
            {replying.date && <span class="muted">{replying.date}</span>}
            <span class="replying-first">{summaryOf(replying.body) ?? ''}</span>
            <button class="icon-button" onClick={() => setReplyTo(undefined)} title="Cancel the reply: the comment goes at the end" aria-label="Cancel the reply">
              <i class="codicon codicon-close" />
            </button>
          </div>
        )}
        <MarkdownBox
          value={comment}
          setValue={setComment}
          placeholder={
            replying
              ? `Reply to ${byName(replying)} (Markdown; Ctrl+Enter posts the reply)`
              : asking
              ? `Answer ${asking}'s question (Markdown; Ctrl+Enter sends it, and ${asking} goes on)`
              : ticket.remote
                ? `Comment in ${ticket.remote.kind === 'jira' ? 'Jira (Markdown, converted to Jira formatting' : 'GitHub (Markdown'}; Ctrl+Enter posts it there)`
                : 'Add a comment (Markdown; paste or drop images and videos; Ctrl+Enter posts)'
          }
          label="Comment"
          onSubmit={post}
          images={!ticket.remote}
          format="markdown"
          mention={mentionPrefix(ticket.item.id)}
        />
        <div class="actions-row">
          {reviewable && (
            <>
              <button
                class="button secondary"
                disabled={!!changesBusy || !!approveBusy}
                onClick={() => review('changes')}
                title="Sends the work back with your comment: an agent picks it up (its implementer's chat, resumed), and asks you first if it needs more context"
              >
                <i class="codicon codicon-request-changes" /> Request Changes
                {changesBusy && <WorkingTag label={changesBusy} />}
              </button>
              <button class="button secondary" disabled={!!changesBusy || !!approveBusy} onClick={() => review('approved')} title="Approves the work, with your comment if you wrote one">
                <i class="codicon codicon-check" /> Approve
                {approveBusy && <WorkingTag label={approveBusy} />}
              </button>
            </>
          )}
          {showRun &&
            (ticket.run ? (
              <ActionButton
                class="button secondary"
                message={{ type: 'run', key: ticket.run!.key, index: ticket.run!.index }}
                working="Running…"
                title={`Runs ${ticket.run.title ? `"${ticket.run.title}"` : 'the latest run block'} in the ticket's worktree, after asking`}
              >
                <i class="codicon codicon-play" /> Run
              </ActionButton>
            ) : (
              <>
                <button class="button secondary" disabled title="The agent didn't give a run block: there's nothing to run">
                  <i class="codicon codicon-play" /> Run
                </button>
                <span class="muted">The agent didn't give a run block.</span>
                {reviewable && (
                  <button
                    class="text-button"
                    onClick={askForRun}
                    title="Puts a request for one in the comment box. Request Changes sends it to the agent; Comment would only leave a note."
                  >
                    Ask it for one
                  </button>
                )}
              </>
            ))}
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
function Dropdown({ class: cls, button, label, items, busy }: { class: string; button: ComponentChildren; label: string; items: MenuItem[]; busy?: string }) {
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
        {busy && <WorkingTag label={busy} />}
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
  const moving = useWorking({ type: 'transition', id: '' });
  return (
    <Dropdown
      class="status-menu"
      busy={moving}
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
        onSelect: () => act({ type: 'transition', id: t.id }, 'Moving…'),
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
  const saving = useWorking({ type: 'remotePriority', name: '' });
  return (
    <Dropdown
      class={`priority${cur ? ` p-${cur}` : ' unset'}`}
      busy={saving}
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
        onSelect: () => act({ type: 'remotePriority', name: n }, 'Saving…'),
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
  // Light (BL-69): its work runs on the light model; reviews stay on the default.
  const light = !chosen.model && chosen.light && ticket.lightModel ? ticket.lightModel : undefined;
  const model = chosen.model ?? light ?? defaults.model;
  const effort = chosen.effort ?? defaults.effort;
  const defaultModel = defaults.model ? `Default (${modelLabel(defaults.model)})` : "Default (Claude Code's)";
  const defaultEffort = defaults.effort ? `Default (${defaults.effort})` : "Default (Claude Code's)";
  const custom = chosen.model && !MODELS.some((m) => m.model === chosen.model!.toLowerCase()) ? [chosen.model] : [];
  return (
    <>
      <Dropdown
        class={`priority agent-choice${chosen.model || light ? '' : ' unset'}`}
        label={`Agents' model: ${model ? modelLabel(model) : 'default'}${light ? ' (Light)' : ''}. Change…`}
        button={
          <>
            <i class="codicon codicon-hubot" />
            <span>{model ? `${light ? 'Light: ' : ''}${modelLabel(model)}` : 'Model'}</span>
          </>
        }
        items={[
          { key: '', label: defaultModel, icon: 'circle-small', checked: !chosen.model && !light, onSelect: () => send({ type: 'agentModel', model: null }) },
          ...(ticket.lightModel
            ? [
                {
                  key: 'light',
                  label: `Light (${modelLabel(ticket.lightModel)})`,
                  detail: 'Small, mechanical work. Reviewed by the default model; moves up to it when it turns out hard',
                  icon: 'feather',
                  checked: !!light,
                  onSelect: () => send({ type: 'agentModel', model: 'light' }),
                },
              ]
            : []),
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

/** Focuses the comment box (where answers go), scrolled into view. */
function focusComment() {
  const box = document.querySelector<HTMLTextAreaElement>('.comment-box textarea');
  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box?.focus();
}

/**
 * An agent's question. On a local ticket its numbered options are buttons: an option is the answer, sent as a comment.
 * On a remote one a comment goes to the tracker, so the options aren't buttons (Answer… writes it there, as you post).
 */
function AskBlock({ ask, title, agent, local, stoppable }: { ask: Ask; title: string; agent?: string; local: boolean; stoppable: boolean }) {
  return (
    <div class="review-panel waiting ask">
      <i class="codicon codicon-question" />
      <div class="ask-text">
        <strong>{title}</strong>
        {ask.question && <div class="ask-question">{ask.question}</div>}
        {local && ask.options.length > 0 && (
          <div class="ask-options">
            {ask.options.map((option, i) => (
              <button
                key={option}
                class={`button${i ? ' secondary' : ''}`}
                onClick={() => sendComment(option)}
                title="Sends this as the answer"
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
      <button class="button secondary" onClick={focusComment} title={`Write the answer to ${agent ?? 'the agent'} in the comment box`}>
        <i class="codicon codicon-comment" /> Answer…
      </button>
      {stoppable && (
        <ActionButton class="button secondary" message={{ type: 'stopReview' }} working="Stopping…" title="Stops the running agent and the handoffs">
          <i class="codicon codicon-debug-stop" /> Stop
        </ActionButton>
      )}
    </div>
  );
}

const STATUS_ICON: Record<string, string> = {
  waiting: 'comment-discussion',
  working: 'rocket',
  done: 'pass-filled',
  idle: 'circle-large-outline',
};

/**
 * The top of the ticket: what's happening now, what an agent asks (with its options), and the actions the state allows.
 * A review, or a clean-up of the history, has its own panel. A review that asks shows its question here instead of its
 * own panel's sentence, so the question is in one place. Remote tickets show questions too (their local reports are
 * here), but the options only as text.
 */
function StateCard({ ticket }: { ticket: TicketView }) {
  const status = ticketStatus({
    status: ticket.item.status,
    review: ticket.review,
    agents: ticket.agents,
    activity: ticket.activity,
    hasWork: ticket.worktrees.length > 0 || ticket.branches.length > 0,
  });
  // The chat an agent works in, or waits in (to open it).
  const chat = ticket.agents.find((a) => a.state === 'waiting-for-input') ?? ticket.agents.find((a) => a.state === 'working');
  const notStarted = ticket.item.status === 'todo' && !ticket.worktrees.length && !ticket.branches.length;
  const asking = !!status.ask && ticket.review?.state === 'asking';
  return (
    <>
      {status.ask && (
        <AskBlock
          ask={status.ask}
          title={status.title}
          agent={ticket.review?.implementer ?? chat?.agent}
          local={!ticket.remote}
          stoppable={asking}
        />
      )}
      {ticket.shaping && <DiscussPanel ticket={ticket} />}
      {ticket.queued && <QueuedPanel queued={ticket.queued} />}
      {outsideAgents(ticket).map((a) => (
        <AgentStatus key={a.id} agent={a} />
      ))}
      {ticket.merging ? (
        <MergingPanel ticket={ticket} />
      ) : ticket.item.merged ? (
        <MergedPanel ticket={ticket} />
      ) : ticket.review && !asking ? (
        <ReviewPanel ticket={ticket} />
      ) : ticket.rewrite ? (
        <CleanUpPanel ticket={ticket} />
      ) : (
        !status.ask && (
          <div class={`review-panel ${status.tone}`}>
            <i class={`codicon codicon-${STATUS_ICON[status.tone]}`} />
            <span class="review-text">
              <strong>{status.title}</strong>
              {status.detail && <span class="muted"> “{status.detail}”</span>}
            </span>
            {chat && (
              <button class="button secondary" onClick={() => send({ type: 'openChat', key: chat.key, id: chat.id })} title="Open this chat in Claude Code">
                <i class="codicon codicon-comment-discussion" /> Open Chat
              </button>
            )}
            {notStarted && (
              <ActionButton
                class="button"
                message={{ type: 'start', agent: true }}
                working="Starting…"
                title="Creates its worktree and starts an agent there; it reports below"
              >
                <i class="codicon codicon-play" /> Run
              </ActionButton>
            )}
          </div>
        )
      )}
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
  const [received, setTicket] = useState<TicketView>();
  // What was just picked (status, priority) shows at once; the view the host sends after the action is the truth.
  const [picked, setPicked] = useState<{ status?: BacklogStatus; priority?: BacklogPriority | null }>({});
  const [ask, setAsk] = useState<AskView>();
  const [ci, setCi] = useState<TicketCiView>();
  useEffect(() => {
    const listener = (e: MessageEvent<TicketHostMessage>) => {
      const m = e.data;
      if (m.type === 'ticket') {
        setTicket(m.ticket);
        setPicked({});
      } else if (m.type === 'ticketParts') {
        // Only the parts that changed came: they go into the view shown. A picked status or priority is the host's
        // once its item comes.
        setTicket((view) => view && applyTicketParts(view, m));
        if (m.parts.item) setPicked({});
      } else if (m.type === 'done') {
        finished(m.message, !!m.failed);
        if (m.message.type === 'status' || m.message.type === 'priority') setPicked({});
      } else if (m.type === 'focus' && m.target === 'demo') setTimeout(() => document.getElementById(DEMO_SECTION)?.scrollIntoView({ block: 'start' }));
      else if (m.type === 'focus') setTimeout(() => document.querySelector<HTMLTextAreaElement>('.comment-box textarea')?.focus());
      else if (m.type === 'ask') setAsk(m.ask);
      else if (m.type === 'ci') setCi(m.ci);
      else if (m.type === 'imageSaved') {
        imageReplies.get(m.requestId)?.(m.markdown);
        imageReplies.delete(m.requestId);
      } else if (m.type === 'previewed') {
        previewReplies.get(m.requestId)?.(m.html);
        previewReplies.delete(m.requestId);
      }
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  if (!received) return <div class="empty-text">Loading…</div>;
  const ticket: TicketView =
    picked.status || picked.priority !== undefined
      ? { ...received, item: { ...received.item, ...(picked.status ? { status: picked.status } : {}), ...(picked.priority !== undefined ? { priority: picked.priority ?? undefined } : {}) } }
      : received;
  const pick = (change: typeof picked, message: TicketWebviewMessage) => {
    setPicked((p) => ({ ...p, ...change }));
    send(message);
  };
  shownEntries = ticket.activity.length;
  const worktrees = ticket.worktrees;
  const active = activeAgents(ticket.agents);
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
                <button key={s.status} role="radio" aria-checked={ticket.item.status === s.status} onClick={() => pick({ status: s.status }, { type: 'status', status: s.status })}>
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
            <PriorityPicker value={ticket.item.priority} onChange={ticket.remote ? undefined : (priority) => pick({ priority }, { type: 'priority', priority })} />
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
        <StateCard ticket={withCiStop(ticket, ci)} />
        <div class="toolbar">
          {!done && (
            <ActionButton
              class="button"
              message={{ type: 'start', agent: true }}
              working="Starting…"
              disabled={ticket.creating}
              title={
                ticket.remote
                  ? 'Creates its worktree if needed and starts a Claude Code agent there; it reports below'
                  : 'Creates its worktree if needed and starts a Claude Code agent there, with the model and effort chosen. It runs in the background, without a window (in the agent queue, as the autopilot’s agents do), and reports below'
              }
            >
              <i class="codicon codicon-play" /> {worktrees.length ? 'Start an Agent' : 'Start with an Agent'}
            </ActionButton>
          )}
          {!done && <CreateWorktreeButton creating={!!ticket.creating} another={worktrees.length > 0} />}
          {!ticket.remote && (
            <>
              {ticket.canDiscuss && (
                <ActionButton
                  class="button secondary"
                  message={{ type: 'discuss' }}
                  working="Starting…"
                  title="An agent talks it through with you here, and writes what's agreed into the description"
                >
                  <i class="codicon codicon-comment-discussion" /> Discuss
                </ActionButton>
              )}
              <button class="button secondary" onClick={() => send({ type: 'openFile' })} title="Edit the whole ticket as Markdown">
                <i class="codicon codicon-go-to-file" /> Open as Markdown
              </button>
              {ticket.canReview && !ticket.review && (
                <ActionButton class="button secondary" message={{ type: 'startReview' }} working="Starting the review…" title="Another agent reviews the work and gives a verdict here">
                  <i class="codicon codicon-eye" /> Start Review
                </ActionButton>
              )}
              {ticket.canCreateIssue && !ticket.links.length && (
                <ActionButton
                  class="button secondary"
                  message={{ type: 'createIssue' }}
                  working="Creating the issue…"
                  title="Creates an issue from this ticket in Jira or GitHub (asks first) and links it"
                >
                  <i class="codicon codicon-cloud-upload" /> Create Issue…
                </ActionButton>
              )}
            </>
          )}
        </div>
      </header>
      {ticket.error && (
        <div class="error-note">
          <i class="codicon codicon-warning" /> {ticket.remote ? `Couldn't read it from ${ticket.remote.label}` : "Couldn't load it"}: {ticket.error}
        </div>
      )}
      <MainState ticket={ticket} />
      <TicketCi ci={ci} send={send} />
      {active.length > 0 && <ActiveAgents ticket={ticket} agents={active} />}
      {((ticket.merge && ticket.merge.state !== 'none') || ticket.item.supersededBy) && <MergePanel ticket={ticket} />}
      <Description ticket={ticket} />
      <DemoSection ticket={ticket} Action={ActionButton} />
      <Attachments ticket={ticket} send={send} Action={ActionButton} />
      <AskPane ask={ask} />
      <Activity ticket={ticket} />
      {ticket.children.length > 0 && <Parts ticket={ticket} />}
      {(worktrees.length > 0 || ticket.branches.length > 0 || ticket.commits.length > 0 || ticket.history.length > 0) && <Work ticket={ticket} />}
      {ticket.agents.length > 0 && <Agents ticket={ticket} />}
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
