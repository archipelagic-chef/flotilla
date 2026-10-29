import type { DiscussionView } from '../ticketProtocol';
import { ActionButton, send } from './actions';
import { ChatBody, type ChatMessages } from './ask';
import { modelName } from './agents';
import './ask.css';

const DISCUSS_MESSAGES: ChatMessages = { send: (text) => send({ type: 'discussSend', text }), stop: { type: 'discussStop' } };

/** The id Discuss scrolls to (see main.tsx). */
export const DISCUSS_SECTION = 'discuss-pane';

/**
 * Discuss (BL-241): the ticket's discussion with its agent, as a chat. The agent opens it, writes what's agreed into the
 * description as you talk, and its summary into the activity when you press Done (or say you're done). It's kept: the
 * pane shows it again when the ticket opens, and a message goes on with it.
 */
export function DiscussPane({ discussion: d, focus }: { discussion: DiscussionView; focus: number }) {
  const turns = d.chat.turns;
  const busy = d.chat.busy;
  return (
    <section class="block ask discuss" id={DISCUSS_SECTION}>
      <div class="block-head">
        <h2>Discuss</h2>
        <span class="muted">with {d.agent}: it writes what you agree on into the description as you talk</span>
        {!d.ended && turns.some((t) => t.answer.trim()) && (
          <span class="head-actions">
            <ActionButton
              class="text-button"
              message={{ type: 'discussDone' }}
              working="Summarizing…"
              disabled={busy}
              title={`${d.agent} writes a short summary of the discussion into the activity: what's agreed, and what's open`}
            >
              <i class="codicon codicon-check" /> Done
            </ActionButton>
          </span>
        )}
      </div>
      {d.held && (
        <div class="hint">
          <i class="codicon codicon-debug-pause" /> You {d.held} {d.agent}: write to it, or Resume, and it goes on.
        </div>
      )}
      <ChatBody
        open
        turns={turns}
        busy={busy}
        messages={DISCUSS_MESSAGES}
        focus={focus}
        placeholder={d.ended ? 'Summarized in the activity. Write to go on… (Enter sends)' : 'Your answer… (Enter sends, Shift+Enter starts a new line)'}
        label={`Discuss this ticket with ${d.agent}`}
        button="Send"
        hint={`${modelName(d.chat.model)} answers, reading the code; the ticket is the only file it changes. The discussion is kept.`}
      />
    </section>
  );
}
