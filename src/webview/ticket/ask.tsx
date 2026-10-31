import {
  useEffect,
  useRef,
  useState,
} from 'preact/hooks';
import type {
  AskTurn,
  AskView,
} from '../../features/backlog/ask';
import {
  act,
  ActionButton,
  send,
  useWorking,
} from './actions';
import { Rendered } from './markdownBox';
import { modelName } from './agents';
import './ask.css';

/** A question in the chat (none for a discussion's opener), and its answer: streaming in as plain text, rendered once it's finished. */
function AskTurnView({ turn: t, index, post }: { turn: AskTurn; index: number; post: boolean }) {
  const finished = t.state === 'done' || (t.state === 'stopped' && !!t.answer.trim());
  return (
    <div class={`ask-turn ${t.state}`}>
      {!t.opener && <div class="ask-question">{t.question}</div>}
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
        {post && finished && (
          <div class="ask-actions">
            {t.posted ? (
              <span class="muted">
                <i class="codicon codicon-check" /> Posted to the ticket
              </span>
            ) : (
              <ActionButton
                class="text-button"
                message={{ type: 'askPost', index }}
                working="Posting…"
                title="Adds the question and this answer to the ticket's activity, as your comment"
              >
                <i class="codicon codicon-comment" /> Post to Ticket
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** What a chat's Stop and its message box send: the Ask chat's, or the Discuss pane's (BL-241). */
export interface ChatMessages {
  send(text: string): void;
  stop: { type: 'askStop' } | { type: 'discussStop' };
}

/** A chat's turns and its message box (Enter sends, Shift+Enter a new line), with Stop while it answers. */
export function ChatBody(o: {
  open: boolean;
  turns: AskTurn[];
  busy: boolean;
  messages: ChatMessages;
  placeholder: string;
  label: string;
  button: string;
  hint: string;
  /** Its finished answers can be posted to the ticket (Ask's). */
  post?: boolean;
  /** Changes when the box is to be focused again (Discuss pressed again). */
  focus?: number;
}) {
  const { open, turns, busy } = o;
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const last = turns[turns.length - 1];
  // Stopping from the click: the answer shows it's stopped once it is.
  const stopSent = !!useWorking(o.messages.stop);
  const stopping = busy && (last?.state === 'stopped' || stopSent);
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open, o.focus]);
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
  }, [open, turns.length, o.focus]);
  useEffect(() => {
    if (open && following.current) end.current?.scrollIntoView({ block: 'nearest' });
  }, [last?.answer.length, last?.state, last?.activity]);
  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    o.messages.send(text);
    setDraft('');
  };
  return (
    <div class="ask-chat">
      {turns.map((t, i) => (
        <AskTurnView key={i} turn={t} index={i} post={!!o.post} />
      ))}
      <div class="ask-input">
        <textarea
          ref={box}
          rows={2}
          value={draft}
          placeholder={o.placeholder}
          aria-label={o.label}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button
            class="button secondary"
            disabled={stopping}
            onClick={() => act(o.messages.stop, 'Stopping…')}
            title="Stops the answer; what it wrote so far stays"
          >
            <i class="codicon codicon-debug-stop" /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button class="button" disabled={!draft.trim()} onClick={submit}>
            <i class="codicon codicon-send" /> {o.button}
          </button>
        )}
      </div>
      <div class="hint" ref={end}>
        {o.hint}
      </div>
    </div>
  );
}

const ASK_MESSAGES: ChatMessages = { send: (text) => send({ type: 'ask', text }), stop: { type: 'askStop' } };

/**
 * Ask (BL-80): a small chat about the ticket, off the record. Folded until opened. What's asked and answered shows only
 * here: it isn't written to the ticket, agents don't see it, and it's gone when the tab closes.
 */
export function AskPane({ ask }: { ask?: AskView }) {
  const [open, setOpen] = useState(false);
  const turns = ask?.turns ?? [];
  return (
    <section class="block ask">
      <div class="block-head">
        <button class="ask-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <i class={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
          <h2>Ask</h2>
          <span class="muted">
            {open ? "Off the record: it isn't written to the ticket, and agents don't see it" : 'A quick question about this ticket, off the record'}
          </span>
        </button>
        {open && turns.length > 0 && (
          <span class="head-actions">
            <ActionButton class="text-button" message={{ type: 'askNew' }} working="Starting over…" title="Starts over: this chat is forgotten">
              <i class="codicon codicon-add" /> New Question
            </ActionButton>
          </span>
        )}
      </div>
      {open && (
        <ChatBody
          open={open}
          turns={turns}
          busy={!!ask?.busy}
          messages={ASK_MESSAGES}
          post
          placeholder={
            turns.length
              ? 'A follow-up… (Enter asks, Shift+Enter starts a new line)'
              : "What's this for? How far is it? Which files does it touch? (Enter asks)"
          }
          label="Ask about this ticket"
          button="Ask"
          hint={`${ask ? `${modelName(ask.model)} answers` : 'A fast model answers'}, reading the code and git only. Closing the ticket forgets the chat.`}
        />
      )}
    </section>
  );
}
