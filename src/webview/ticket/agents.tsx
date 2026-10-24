import { formatTokens } from '../../features/chats/usage';
import { DEFAULT_STUCK_RULES, health, nowLine, progress, type StuckRules } from '../../features/chats/activity';
import { useEffect, useState } from 'preact/hooks';
import type { AgentChatView, TicketView } from '../ticketProtocol';
import { lastReport, runningFor } from '../activeAgents';
import { ActionButton, send } from './actions';
import { Rendered } from './markdownBox';
import { FIX_TIP } from './reviewPanel';
import { stoppedLabel } from '../shortTime';
import './agents.css';

export const CHAT_STATE: Record<string, { label: string; cls: string }> = {
  working: { label: 'Working', cls: 'working' },
  'waiting-for-input': { label: 'Waiting for you', cls: 'waiting' },
  done: { label: 'Done', cls: 'done' },
  ended: { label: 'Ended', cls: 'ended' },
};

/** How a chat's state reads: a chat that went quiet says since when (BL-131), the others their state. */
export function chatState(chat: { state: string; stalled?: string }): { label: string; cls: string } {
  return chat.stalled ? { label: stoppedLabel(chat.stalled), cls: 'ended' } : (CHAT_STATE[chat.state] ?? CHAT_STATE.ended);
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** An agent's chat, linked from the entry that started it: click to open it in Claude Code. */
export function ChatCard({ chat }: { chat: AgentChatView }) {
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
  const state = chatState(chat);
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

export const PAUSE_TIP = 'Stops it now and keeps its chat; its work stays in the worktree as it is. Resume goes on in the same chat';
export const STOP_TIP = 'Ends it (its chat is kept): resume it later, or hand the work to a new agent';

/** The busy agents the review panel doesn't show (started by hand, not by the loop). */
export function outsideAgents(ticket: TicketView): TicketView['agents'] {
  const r = ticket.review;
  const own = r?.state === 'reviewing' ? r.reviewerSession : r?.state === 'working' || r?.state === 'revising' ? r.implementerSession : undefined;
  // The discussion's agent shows in its own panel.
  return ticket.agents.filter((a) => a.runs && a.id !== own && !((ticket.shaping?.running || ticket.shaping?.chat === 'open') && a.agent === ticket.shaping.agent));
}

/**
 * An agent working on the ticket outside the review loop (started by hand): one in a terminal can be paused and
 * stopped here; one in Claude Code's panel only there (its chat opens).
 */
export function AgentStatus({ agent: a }: { agent: TicketView['agents'][number] }) {
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

/** A model as people say it: "claude-opus-5-5" is Opus 5.5, an alias ("sonnet") is Sonnet. */
export function modelName(model: string): string {
  const m = /^(?:claude-)?([a-z]+)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?$/i.exec(model);
  if (!m) return model;
  const family = `${m[1][0].toUpperCase()}${m[1].slice(1)}`;
  return m[2] ? `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : family;
}

/** A line with `code` in it, the code shown as such. */
export function WithCode({ text }: { text: string }) {
  return <>{text.split('`').map((part, n) => (n % 2 ? <code key={n}>{part}</code> : part))}</>;
}

/**
 * What a working agent is doing (BL-175): now (a click opens its transcript), its latest thought (unfolding to the last
 * few), its plan's progress (unfolding to the list), and its health: when it last wrote, or why it looks stuck, with
 * what to do about it.
 */
export function LiveStatus({ agent: a, rules }: { agent: TicketView['agents'][number]; rules: StuckRules }) {
  const activity = a.activity;
  if (!activity) return null;
  const now = nowLine(activity);
  const plan = progress(activity);
  const thoughts = activity.thoughts ?? [];
  const h = health(activity, a.updated, rules, !!a.runs && !a.held && a.state === 'working');
  return (
    <div class={`agent-live${h.stuck ? ' stuck' : ''}`}>
      {now && (
        <button key="now" class="agent-now" onClick={() => send({ type: 'openChat', key: a.key, id: a.id })} title="Open its live transcript">
          <i class={`codicon ${now.running ? 'codicon-loading codicon-modifier-spin' : 'codicon-tools'}`} /> <WithCode text={now.text} />
        </button>
      )}
      {thoughts.length > 0 &&
        (thoughts.length > 1 ? (
          <details key="thoughts" class="agent-thoughts">
            <summary title="Its latest thought: unfold for the last few">“{thoughts.at(-1)}”</summary>
            <ol>
              {thoughts.slice(0, -1).map((t, n) => (
                <li key={n}>“{t}”</li>
              ))}
            </ol>
          </details>
        ) : (
          <div key="thought" class="agent-thoughts">“{thoughts[0]}”</div>
        ))}
      {plan && (
        <details key="plan" class="agent-plan">
          <summary title="Its plan (its todo list): unfold for the steps">
            <progress max={plan.total} value={plan.done} /> {plan.done} of {plan.total}
            {plan.current ? ` · ${plan.current}` : ''}
          </summary>
          <ul>
            {activity.todos!.map((t, n) => (
              <li key={n} class={`todo ${t.status}`}>
                <i class={`codicon ${t.status === 'completed' ? 'codicon-pass-filled' : t.status === 'in_progress' ? 'codicon-circle-large-filled' : 'codicon-circle-large-outline'}`} /> {t.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div key="health" class={`agent-health${h.stuck ? ' stuck' : ''}`}>
        <i class={`codicon ${h.stuck ? 'codicon-warning' : 'codicon-pulse'}`} /> <WithCode text={h.stuck ? `Looks stuck: ${h.text}` : h.text} />
        {h.stuck && (
          <span class="agent-health-actions">
            <ActionButton class="button secondary" message={{ type: 'openChat', key: a.key, id: a.id }} working="Opening…" title="Open its live transcript">
              <i class="codicon codicon-output" /> Open Transcript
            </ActionButton>
            <ActionButton class="button secondary" message={{ type: 'check' }} working="Checking…" title="Check the ticket: its agents, worktree and state">
              <i class="codicon codicon-checklist" /> Check
            </ActionButton>
            {a.runs !== 'panel' && (
              <ActionButton class="button secondary" message={{ type: 'agent', action: 'stop', session: a.id }} working="Stopping…" title={STOP_TIP}>
                <i class="codicon codicon-debug-stop" /> Stop
              </ActionButton>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** Every agent on the ticket now, in full: its state, how long it has run, its worktree, what it's doing, what it last reported. */
export function ActiveAgents({ ticket, agents }: { ticket: TicketView; agents: TicketView['agents'] }) {
  // How long each has run goes on counting between updates: every second while one's status shows a clock.
  const live = agents.some((a) => a.activity);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === 'visible' && tick((n) => n + 1), live ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [live]);
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
              <LiveStatus agent={a} rules={ticket.stuckRules ?? DEFAULT_STUCK_RULES} />
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
export function Agents({ ticket }: { ticket: TicketView }) {
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
          const state = a.held ? { label: a.held === 'paused' ? 'Paused' : 'Stopped', cls: 'waiting' } : chatState(a);
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
