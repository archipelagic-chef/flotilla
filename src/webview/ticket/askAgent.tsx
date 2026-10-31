import {
  useEffect,
  useState,
} from 'preact/hooks';
import { askLabel } from '../../features/backlog/askAgent';
import { byPerson } from '../../features/backlog/ticket';
import { clock } from '../../features/chats/activity';
import type { TicketView } from '../ticketProtocol';
import { act } from './actions';
import './askAgent.css';

type Entry = TicketView['activity'][number];

/** Whether an entry is a comment of yours (or from the ticket's pull request, BL-224) that an agent can be asked to answer (BL-127). */
export function askable(e: Entry, ticket: TicketView): boolean {
  return !!ticket.canAsk && !!e.anchor && byPerson(e.author);
}

/** Ask an Agent, in a comment's head: there until an agent is asked (its line then offers Stop, or Retry). */
export function AskButton({ e, ticket }: { e: Entry; ticket: TicketView }) {
  if (!askable(e, ticket) || ticket.asked?.[e.anchor!]) return null;
  return (
    <button
      class="text-button ask-agent"
      onClick={() => act({ type: 'askAgent', anchor: e.anchor! }, 'Asking…')}
      title="An agent answers this comment now, as a reply to it"
    >
      <i class="codicon codicon-sparkle" /> Ask an Agent
    </button>
  );
}

/** Ticks once a second while shown: how long the agent has been thinking. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * Under a comment asked about: "Iris-3 is thinking…" with what it does now, the time since it started and Stop; waiting
 * for the implementer's turn, with Answer Now; Retry once it's over (replied, stopped or failed).
 */
export function AskLine({ e, ticket }: { e: Entry; ticket: TicketView }) {
  const a = e.anchor ? ticket.asked?.[e.anchor] : undefined;
  const now = useClock(a?.state === 'thinking');
  if (!a || !askable(e, ticket)) return null;
  const anchor = e.anchor!;
  const thinking = a.state === 'thinking';
  return (
    <div class={`ask-line ask-${a.state}`} role="status">
      <i
        class={`codicon codicon-${thinking ? 'loading codicon-modifier-spin' : a.state === 'waiting' ? 'clock' : a.state === 'answered' ? 'check' : 'warning'}`}
      />
      <span class="ask-label">{askLabel(a)}</span>
      {thinking && a.now && <span class="ask-now">{a.now}</span>}
      {thinking && a.since && <span class="muted ask-time">{clock(now - new Date(a.since).getTime())}</span>}
      {(thinking || a.state === 'waiting') && (
        <button class="text-button" onClick={() => act({ type: 'askAgentStop', anchor }, 'Stopping…')} title="Ends it now: nothing is written in the ticket">
          <i class="codicon codicon-debug-stop" /> Stop
        </button>
      )}
      {a.state === 'waiting' && (
        <button
          class="text-button"
          onClick={() => act({ type: 'askAgent', anchor, now: true }, 'Asking…')}
          title="A separate agent answers now, instead of waiting"
        >
          <i class="codicon codicon-zap" /> Answer Now
        </button>
      )}
      {!thinking && a.state !== 'waiting' && (
        <button
          class="text-button"
          onClick={() => act({ type: 'askAgent', anchor }, 'Asking…')}
          title={a.state === 'answered' ? 'Asks again for a new answer: the old reply stays' : 'Asks again'}
        >
          <i class="codicon codicon-refresh" /> Retry
        </button>
      )}
    </div>
  );
}
