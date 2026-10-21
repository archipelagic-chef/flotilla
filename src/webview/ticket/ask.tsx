import { useEffect, useRef, useState } from 'preact/hooks';
import type { AskTurn, AskView } from '../../features/backlog/ask';
import { send } from './actions';
import { Rendered } from './markdownBox';
import { modelName } from './agents';

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
export function AskPane({ ask }: { ask?: AskView }) {
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
