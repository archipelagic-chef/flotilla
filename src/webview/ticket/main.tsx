import { Component, render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type BacklogPriority, type BacklogStatus } from '../../features/backlog/backlog';
import type { AskView } from '../../features/backlog/ask';
import type {
  TicketCiView,
  TicketHostMessage,
  TicketView,
  TicketWebviewMessage,
} from '../ticketProtocol';
// The shared rules first: each section's own CSS, imported by its module, comes after them.
import '../ui/priority.css';
import './ticket.css';
import { Attachments, showAnchor } from './attachments';
import { DEMO_SECTION, DemoSection } from './demo';
import { applyTicketParts } from '../ticketParts';
import { activeAgents } from '../activeAgents';
import { PriorityPicker } from '../ui/priority';
import { TicketCi } from './ci';
import {
  ActionButton,
  finished,
  send,
  useWorkingChanges,
  workingLabel,
} from './actions';
import { showingEntries } from './comments';
import {
  ChangeLinks,
  entryReplies,
  imageReplies,
  previewReplies,
} from './markdownBox';
import { checksLogReplies } from './checksPanel';
import {
  AgentPicker,
  RemotePriority,
  STATUSES,
  StatusMenu,
  Title,
} from './header';
import { Description } from './description';
import { AskPane } from './ask';
import { ActiveAgents, Agents, RESUME_TIP } from './agents';
import { MainState, MergePanel, withCiStop } from './mergePanel';
import { CreateWorktreeButton, Parts, Work } from './work';
import { changeDiffReplies, Changes } from './changes';
import { DiffView, type FullAt } from './diffView';
import { Activity } from './activity';
import { StateCard } from './stateCard';
import { ticketSteps } from './steps';
import { STEP } from '../../features/backlog/nextSteps';
import { CheckResult } from './checkResult';

/**
 * The ticket's linked issues. One being unlinked stays until the host is done, so its "Unlinking…" is seen (the
 * ticket the host sends first has it gone already).
 */
function LinkChips({ links }: { links: TicketView['links'] }) {
  useWorkingChanges();
  const seen = useRef(new Map<string, TicketView['links'][number]>());
  for (const l of links) seen.current.set(l.id, l);
  for (const id of seen.current.keys()) {
    if (!links.some((l) => l.id === id) && !workingLabel({ type: 'unlink', id })) seen.current.delete(id);
  }
  const shown = [...seen.current.values()];
  return (
    <>
      {shown.map((l) => (
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
          <ActionButton class="link-remove" message={{ type: 'unlink', id: l.id }} working="Unlinking…" title={`Unlink ${l.id}`} aria-label={`Unlink ${l.id}`}>
            <i class="codicon codicon-close" />
          </ActionButton>
        </span>
      ))}
    </>
  );
}

function App() {
  const [received, setTicket] = useState<TicketView>();
  // What was just picked (status, priority) shows at once; the view the host sends after the action is the truth.
  const [picked, setPicked] = useState<{ status?: BacklogStatus; priority?: BacklogPriority | null }>({});
  const [ask, setAsk] = useState<AskView>();
  const [ci, setCi] = useState<TicketCiView>();
  /**
   * A file of its Changes expanded to the whole tab (BL-171): only its diff shows, under a header that leads back,
   * the ticket kept as it was underneath (its folds, drafts); Back shows it again where it was scrolled to, the file
   * marked. The sidebar's Version Control follows, on the ticket's Changes with that file selected (unless it's the
   * one that asked: from: 'host').
   */
  const [full, setFull] = useState<FullAt>();
  const [marked, setMarked] = useState<string>();
  const scrolled = useRef<number>();
  const fullRef = useRef<FullAt>();
  fullRef.current = full;
  const expand = (at: FullAt, from?: 'host') => {
    if (!fullRef.current) scrolled.current = window.scrollY;
    fullRef.current = at;
    setFull(at);
    setMarked(at.path);
    if (from !== 'host') send({ type: 'expandChange', group: at.group, path: at.path });
  };
  const back = () => setFull(undefined);
  useEffect(() => {
    if (full || scrolled.current === undefined) return;
    window.scrollTo(0, scrolled.current);
    scrolled.current = undefined;
  }, [full]);
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
      } else if (m.type === 'focus' && typeof m.target === 'object') {
        const { entry, gone } = m.target;
        setTimeout(() => showAnchor(entry, gone));
      } else if (m.type === 'focus' && m.target === 'demo') setTimeout(() => document.getElementById(DEMO_SECTION)?.scrollIntoView({ block: 'start' }));
      else if (m.type === 'focus') setTimeout(() => document.querySelector<HTMLTextAreaElement>('.comment-box textarea')?.focus());
      else if (m.type === 'ask') setAsk(m.ask);
      // Back from VS Code's diff editor: the ticket at its Changes (which scroll there themselves).
      // A file of its Changes picked in the sidebar's Version Control: its diff.
      else if (m.type === 'showFull') expand({ group: m.group, path: m.path }, 'host');
      else if (m.type === 'showChange') {
        scrolled.current = undefined;
        setFull(undefined);
      } else if (m.type === 'ci') setCi(m.ci);
      else if (m.type === 'imageSaved') {
        imageReplies.get(m.requestId)?.(m.markdown);
        imageReplies.delete(m.requestId);
      } else if (m.type === 'checksLog') {
        checksLogReplies.get(m.requestId)?.(m.text);
        checksLogReplies.delete(m.requestId);
      } else if (m.type === 'entries') {
        entryReplies.get(m.requestId)?.(m.entries);
        entryReplies.delete(m.requestId);
      } else if (m.type === 'changeDiff') {
        changeDiffReplies.get(m.requestId)?.(m.diff);
        changeDiffReplies.delete(m.requestId);
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
      ? {
          ...received,
          item: {
            ...received.item,
            ...(picked.status ? { status: picked.status } : {}),
            ...(picked.priority !== undefined ? { priority: picked.priority ?? undefined } : {}),
          },
        }
      : received;
  const pick = (change: typeof picked, message: TicketWebviewMessage) => {
    setPicked((p) => ({ ...p, ...change }));
    send(message);
  };
  showingEntries(ticket.activity.length);
  const worktrees = ticket.worktrees;
  const active = activeAgents(ticket.agents);
  const done = ticket.item.status === 'done';
  const steps = ticketSteps(ticket, ci);
  const working = steps.main === 'openChat';
  // Its agent stopped to be resumed (BL-198): Resume leads, and Start an Agent (afresh) follows.
  const resume = steps.main === 'resume';
  return (
    // The ticket's change for the diff marks on links to its files (BL-174).
    <ChangeLinks.Provider value={ticket.changes}>
      {full && <DiffView ticket={ticket} at={full} back={back} go={expand} />}
      <main class="ticket" hidden={!!full}>
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
                  <button
                    key={s.status}
                    role="radio"
                    aria-checked={ticket.item.status === s.status}
                    onClick={() => pick({ status: s.status }, { type: 'status', status: s.status })}
                  >
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
                {ticket.item.proposed.by ? `${ticket.item.proposed.by} (an agent)` : 'An agent'} proposed this ticket. Accept it into the backlog, or dismiss
                it.
              </span>
              <ActionButton class="button" message={{ type: 'accept' }} working="Accepting…">
                <i class="codicon codicon-check" /> Accept
              </ActionButton>
              <ActionButton class="button secondary" message={{ type: 'dismiss' }} working="Dismissing…">
                Dismiss
              </ActionButton>
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
              <PriorityPicker
                value={ticket.item.priority}
                onChange={ticket.remote ? undefined : (priority) => pick({ priority }, { type: 'priority', priority })}
              />
            )}
            {!ticket.remote && <AgentPicker ticket={ticket} />}
            <LinkChips links={ticket.links} />
            {!ticket.remote && (
              <ActionButton class="add-link" message={{ type: 'link' }} working="Linking…" title="Link it to an issue in Jira or GitHub Issues">
                <i class="codicon codicon-link" /> {ticket.links.length ? 'Link' : 'Link Issue'}
              </ActionButton>
            )}
          </div>
          <StateCard ticket={withCiStop(ticket, ci)} ci={ci} />
          <div class="toolbar">
            {/* Not while an agent works on it (BL-154): its chat opens from the state above, and Stop is there. */}
            {resume && (
              <ActionButton class="button" message={{ type: 'agent', action: 'resume' }} working="Resuming…" title={RESUME_TIP}>
                <i class={`codicon codicon-${STEP.resume.icon}`} /> {STEP.resume.label}
              </ActionButton>
            )}
            {!done && !working && (
              <ActionButton
                class={resume ? 'button secondary' : 'button'}
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
                    working="Opening…"
                    title={
                      ticket.shaping?.chat && ticket.shaping.chat !== 'pending'
                        ? "Opens the discussion's chat again: it goes on there"
                        : "Opens a chat with an agent beside the ticket: it talks it through with you, and writes what's agreed into the description"
                    }
                  >
                    <i class="codicon codicon-comment-discussion" /> Discuss
                  </ActionButton>
                )}
                <button class="button secondary" onClick={() => send({ type: 'openFile' })} title="Edit the whole ticket as Markdown">
                  <i class="codicon codicon-go-to-file" /> Open as Markdown
                </button>
                <ActionButton
                  class="button secondary"
                  message={{ type: 'check' }}
                  working="Checking…"
                  title="Checks each thing the ticket says is going on (agents working, a review, a merge) against what really runs; nothing changes until you Clean Up"
                >
                  <i class="codicon codicon-pulse" /> Check
                </ActionButton>
                {ticket.canReview && !ticket.review && (
                  <ActionButton
                    class="button secondary"
                    message={{ type: 'startReview' }}
                    working="Starting the review…"
                    title="Another agent reviews the work and gives a verdict here"
                  >
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
        {ticket.check && <CheckResult check={ticket.check} />}
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
        <Changes ticket={ticket} expand={expand} marked={marked} />
        {ticket.agents.length > 0 && <Agents ticket={ticket} />}
      </main>
    </ChangeLinks.Provider>
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
