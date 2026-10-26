import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { NoteHostMessage, NoteTabView, NoteWebviewMessage } from '../noteProtocol';
// The ticket's shared rules (buttons, the comment box's layout) first, then the note's own.
import '../ticket/ticket.css';
import { send as sendTicket } from '../ticket/actions';
import { imageReplies, MarkdownBox, previewReplies } from '../ticket/markdownBox';
import './note.css';

/** The page's one VS Code API (the ticket's module acquired it), for the note's messages as well as the box's. */
const send = sendTicket as (message: NoteWebviewMessage) => void;

/**
 * The New Note tab (BL-182): you write the note as you'd write a comment on a ticket, with the formatting toolbar,
 * Preview and pasted images, and Send gives it to an agent.
 */
function NewNote() {
  const [text, setText] = useState('');
  const [mention, setMention] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<NoteTabView | undefined>(undefined);
  useEffect(() => {
    const listener = (e: MessageEvent<NoteHostMessage>) => {
      const m = e.data;
      if (m.type === 'noteInit') {
        setMention(m.mention);
        setNote(m.note);
      } else if (m.type === 'noteChanged') setNote(m.note);
      else if (m.type === 'imageSaved') {
        imageReplies.get(m.requestId)?.(m.markdown);
        imageReplies.delete(m.requestId);
      } else if (m.type === 'previewed') {
        previewReplies.get(m.requestId)?.(m.html);
        previewReplies.delete(m.requestId);
      } else if (m.type === 'noteSent') {
        setSending(false);
        setFailed(m.failed);
      }
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  if (note) return <SentNote note={note} mention={mention} />;
  const submit = () => {
    if (sending || !text.trim()) return;
    setSending(true);
    setFailed(undefined);
    send({ type: 'noteSend', text });
  };
  return (
    <main class="note-page">
      <h1>
        <i class="codicon codicon-note" /> New Note
      </h1>
      <p class="note-intro">
        What you'd ask an agent for, as loosely as you like. An agent reads the code and the backlog, asks you in the note when it must, and turns it into
        ticket proposals.
      </p>
      <div class="comment-box">
        <MarkdownBox
          value={text}
          setValue={setText}
          placeholder="Jot down an idea, a bug, a wish… (Markdown; paste or drop images; Ctrl+Enter sends it)"
          label="Note"
          onSubmit={submit}
          autoFocus
          minRows={10}
          format="markdown"
          mention={mention}
        />
        <div class="actions-row">
          <button
            class="button note-send"
            disabled={sending || !text.trim()}
            onClick={submit}
            title="Sends the note: it shows in the backlog's Notes lane, and an agent picks it up"
          >
            <i class="codicon codicon-send" /> {sending ? 'Sending…' : 'Send to an Agent'}
          </button>
        </div>
        {failed && (
          <div class="error-note">
            <i class="codicon codicon-warning" /> {failed}
          </div>
        )}
      </div>
    </main>
  );
}

const STATUS: Record<NoteTabView['status'], { icon: string; label: (n: NoteTabView) => string; saving: string }> = {
  open: {
    icon: 'clock',
    label: (n) => (n.agent ? `Waiting for ${n.agent} to go on` : 'Waiting for an agent'),
    saving: 'An agent takes it as it is when it picks it up; one that has it goes on with your change.',
  },
  working: {
    icon: 'loading codicon-modifier-spin',
    label: (n) => `${n.agent ?? 'An agent'} is turning it into tickets`,
    saving: 'Its agent gets your change when it ends its turn, and goes on with it.',
  },
  asking: { icon: 'comment-discussion', label: (n) => `${n.agent ?? 'Its agent'} asks you`, saving: 'Its agent goes on with your change, as with an answer.' },
  handled: { icon: 'pass', label: () => 'Handled', saving: 'Saving opens it again: its agent updates the tickets it became.' },
};

/**
 * A sent note's tab (BL-204): what you wrote, editable whatever its state (Save keeps the change as an entry, and its
 * agent takes it in), its activity, and a box to write a comment in: your answer when its agent asks.
 */
function SentNote({ note, mention }: { note: NoteTabView; mention: string }) {
  // What you wrote, as last saved: a change from the host replaces the box's text only when you haven't changed it.
  const [saved, setSaved] = useState(note.text);
  const [text, setText] = useState(note.text);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'save' | 'comment' | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  if (note.text !== saved) {
    setSaved(note.text);
    if (text === saved) setText(note.text);
  }
  useEffect(() => {
    const listener = (e: MessageEvent<NoteHostMessage>) => {
      const m = e.data;
      if (m.type !== 'noteDone') return;
      setBusy(undefined);
      setFailed(m.failed);
      if (!m.failed && m.op === 'comment') setComment('');
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  const status = STATUS[note.status];
  const dirty = text.trim() !== note.text.trim();
  const save = () => {
    if (busy || !dirty || !text.trim()) return;
    setBusy('save');
    setFailed(undefined);
    send({ type: 'noteSave', text });
  };
  const post = () => {
    if (busy || !comment.trim()) return;
    setBusy('comment');
    setFailed(undefined);
    send({ type: 'noteComment', text: comment });
  };
  return (
    <main class="note-page">
      <h1>
        <i class="codicon codicon-note" /> {note.id}
      </h1>
      <p class="note-intro note-tab-status">
        <i class={`codicon codicon-${status.icon}`} /> {status.label(note)}
        {note.became && <span class="note-tab-became"> · {note.became}</span>}
        {note.with && (
          <span>
            {' '}
            · handled with{' '}
            <button class="link" onClick={() => send({ type: 'noteOpen', id: note.with! })}>
              {note.with}
            </button>
            , where your comments go
          </span>
        )}
      </p>
      <div class="comment-box">
        <MarkdownBox
          value={text}
          setValue={setText}
          placeholder="What you'd ask an agent for"
          label="Note"
          onSubmit={save}
          minRows={6}
          format="markdown"
          mention={mention}
        />
        <div class="actions-row">
          <span class="note-tab-hint">{dirty ? status.saving : ''}</span>
          {dirty && (
            <button class="button secondary" disabled={!!busy} onClick={() => setText(note.text)} title="Puts back what the note says">
              Undo Changes
            </button>
          )}
          <button class="button note-save" disabled={!!busy || !dirty || !text.trim()} onClick={save} title={status.saving}>
            <i class="codicon codicon-save" /> {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <h2 class="note-tab-activity-head">Activity</h2>
      {note.activity.length === 0 && <p class="note-intro">Nothing yet: its agent's replies, your comments and edits show here.</p>}
      {note.activity.map((e, i) => (
        <div key={`${e.date}-${i}`} class={`note-entry ${e.author === 'You' ? 'note-entry-you' : ''}`}>
          <div class="note-entry-head">
            <b>{e.author}</b> · {e.date}
          </div>
          <div class="rendered" dangerouslySetInnerHTML={{ __html: e.html }} />
        </div>
      ))}
      <div class="comment-box">
        <MarkdownBox
          value={comment}
          setValue={setComment}
          placeholder={note.status === 'asking' ? 'Your answer (Ctrl+Enter sends it)' : 'Write more: a comment its agent takes in (Ctrl+Enter sends it)'}
          label={note.status === 'asking' ? 'Answer' : 'Comment'}
          onSubmit={post}
          minRows={3}
          format="markdown"
          mention={mention}
        />
        <div class="actions-row">
          <button class="button note-comment" disabled={!!busy || !comment.trim()} onClick={post}>
            <i class="codicon codicon-comment" /> {busy === 'comment' ? 'Sending…' : note.status === 'asking' ? 'Answer' : 'Comment'}
          </button>
        </div>
      </div>
      {failed && (
        <div class="error-note">
          <i class="codicon codicon-warning" /> {failed}
        </div>
      )}
    </main>
  );
}

render(<NewNote />, document.getElementById('root')!);
