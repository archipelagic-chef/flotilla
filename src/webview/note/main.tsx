import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { NoteHostMessage, NoteWebviewMessage } from '../noteProtocol';
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
  useEffect(() => {
    const listener = (e: MessageEvent<NoteHostMessage>) => {
      const m = e.data;
      if (m.type === 'noteInit') setMention(m.mention);
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

render(<NewNote />, document.getElementById('root')!);
