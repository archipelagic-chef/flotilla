import { render } from 'preact';
import {
  useEffect,
  useState,
} from 'preact/hooks';
import type {
  DiscussionHostMessage,
  DiscussionTabView,
  DiscussionWebviewMessage,
} from '../discussionProtocol';
import type { TicketWebviewMessage } from '../ticketProtocol';
// The ticket's rules (its rendered Markdown, buttons, the Discuss pane's chat) first, then the discussion's own.
import '../ticket/ticket.css';
import {
  act,
  finished,
  send as sendTicket,
} from '../ticket/actions';
import {
  ChatBody,
  type ChatMessages,
} from '../ticket/ask';
import { modelName } from '../ticket/agents';
import './discussion.css';

/** The page's one VS Code API (the ticket's module acquired it): the chat's and Rendered's messages come through it too. */
const send = sendTicket as (message: DiscussionWebviewMessage) => void;

const MESSAGES: ChatMessages = { send: (text) => send({ type: 'discussSend', text }), stop: { type: 'discussStop' } };

/** A discussion (BL-267): its title with Rename and Delete, then the chat, as a ticket's Discuss pane shows it. */
function Discussion() {
  const [d, setD] = useState<DiscussionTabView | undefined>();
  useEffect(() => {
    const on = (e: MessageEvent<DiscussionHostMessage>) => {
      const m = e.data;
      if (m.type === 'discussion') setD(m.view);
      else if (m.type === 'done') finished(m.message as TicketWebviewMessage, !!m.failed);
    };
    window.addEventListener('message', on);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', on);
  }, []);
  if (!d) return <p class="discussion-empty">Reading the discussion…</p>;
  const started = d.chat.turns.length > 0;
  return (
    <div class="discussion">
      <div class="discussion-head">
        <h1>{d.title}</h1>
        {started && (
          <span class="head-actions">
            <button class="icon" aria-label="Rename" title="Rename" onClick={() => act({ type: 'rename' } as unknown as TicketWebviewMessage, 'Renaming…')}>
              <i class="codicon codicon-edit" />
            </button>
            <button class="icon" aria-label="Delete" title="Delete" onClick={() => act({ type: 'delete' } as unknown as TicketWebviewMessage, 'Deleting…')}>
              <i class="codicon codicon-trash" />
            </button>
          </span>
        )}
      </div>
      <p class="muted">A free discussion about this repository and its backlog: no tickets, nothing changed.</p>
      {d.paused && (
        <div class="hint">
          <i class="codicon codicon-debug-pause" /> Pause All stopped it: write, and it goes on.
        </div>
      )}
      <section class="block ask discuss">
        <ChatBody
          open
          turns={d.chat.turns}
          busy={d.chat.busy}
          messages={MESSAGES}
          placeholder={
            started ? 'Your answer… (Enter sends, Shift+Enter starts a new line)' : "What's on your mind? (Enter sends, Shift+Enter starts a new line)"
          }
          label="Discuss with an agent"
          button="Send"
          hint={`${modelName(d.chat.model)} answers, reading the code and the backlog; it changes nothing. The discussion is kept.`}
        />
      </section>
    </div>
  );
}

render(<Discussion />, document.getElementById('root')!);
