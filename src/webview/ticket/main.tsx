import { Component, render, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { type BacklogPriority, type BacklogStatus } from '../../features/backlog/backlog';
import type { AskView } from '../../features/backlog/ask';
import type { TicketCiView, TicketHostMessage, TicketView, TicketWebviewMessage } from '../ticketProtocol';
import { Attachments } from './attachments';
import { DEMO_SECTION, DemoSection } from './demo';
import { applyTicketParts } from '../ticketParts';
import { activeAgents } from '../activeAgents';
import { PriorityPicker } from '../ui/priority';
import '../ui/priority.css';
import { ticketStatus, type Ask } from '../ticketStatus';
import './ticket.css';
import { TicketCi } from './ci';
import { ActionButton, finished, send } from './actions';
import { focusComment, sendComment, showingEntries } from './comments';
import { imageReplies, previewReplies } from './markdownBox';
import { AgentPicker, RemotePriority, STATUSES, StatusMenu, Title } from './header';
import { Description } from './description';
import { AskPane } from './ask';
import { ActiveAgents, Agents, AgentStatus, outsideAgents } from './agents';
import { DiscussPanel, QueuedPanel, ReviewPanel } from './reviewPanel';
import { CleanUpPanel, MainState, MergedPanel, MergePanel, MergingPanel, withCiStop } from './mergePanel';
import { CreateWorktreeButton, Parts, Work } from './work';
import { Activity } from './activity';

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
  showingEntries(ticket.activity.length);
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
