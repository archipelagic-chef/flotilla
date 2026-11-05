import type { WorkstreamView } from '../protocol';
import {
  menuContext,
  run,
} from './api';
import type { Update } from './app';
import {
  chatList,
  type ListedChat,
  type ListState,
  listState,
} from './chatList';
import './chats.css';

const STATE_ICON: Record<ListState, string> = {
  waiting: 'bell-dot st-waiting',
  unseen: 'circle-filled st-unseen',
  working: 'loading codicon-modifier-spin st-working',
  stopped: 'debug-stop st-stopped',
  done: 'pass st-done',
  ended: 'history muted',
};

const STATE_LABEL: Record<ListState, string> = {
  waiting: 'waiting for you',
  unseen: 'new reply',
  working: 'working',
  stopped: 'stopped',
  done: 'finished',
  ended: 'ended',
};

interface Props {
  workstreams: readonly WorkstreamView[];
  colors: ReadonlyMap<string, string>;
  /** The selected tab's worktree: New Chat offers it first. */
  first?: string;
  hideDetached: boolean;
  update: Update;
  openTicket(id: string): void;
}

/** Shown once above the chat lists while some worktree lacks the hooks that report chat state. */
export function HooksNotice({ missing }: { missing: number }) {
  if (!missing) return null;
  return (
    <div class="notice">
      <i class="codicon codicon-info" />
      <span>Install the Claude Code hooks to see which chats are working or waiting for you{missing > 1 ? ` (${missing} worktrees without them)` : ''}.</span>
      <button class="link" onClick={() => run('flotilla.installClaudeHooks')}>
        Install
      </button>
    </div>
  );
}

/** Every chat of every worktree in one list, newest first (BL-286, Design B). */
export function ChatsBody({ workstreams, colors, first, hideDetached, update, openTicket }: Props) {
  const all = chatList(workstreams);
  const detached = all.filter((c) => c.chat.detached).length;
  const shown = hideDetached ? all.filter((c) => !c.chat.detached) : all;
  const firstKey = first ?? workstreams.find((w) => w.isCurrent)?.key ?? workstreams[0]?.key;
  return (
    <div class="chats">
      <div class="chats-bar">
        <button class="row new-chat" onClick={() => firstKey && run('flotilla.newChat', { key: firstKey, pick: true })}>
          <i class="codicon codicon-add" />
          <span class="name">New chat…</span>
        </button>
        {detached > 0 && (
          <button
            class="link agents-toggle"
            aria-pressed={!hideDetached}
            data-tip={hideDetached ? `Show Flotilla's agents (${detached})` : "Hide Flotilla's agents"}
            onClick={() => update((p) => ({ ...p, hideDetached: !p.hideDetached }))}
          >
            <i class={`codicon codicon-${hideDetached ? 'eye-closed' : 'eye'}`} />
            Agents: {hideDetached ? `hidden (${detached})` : 'shown'}
          </button>
        )}
      </div>
      {shown.map((c) => (
        <ChatRow key={c.chat.id} item={c} color={colors.get(c.runsIn.key)} openTicket={openTicket} />
      ))}
      {shown.length === 0 && <div class="empty">No chats{hideDetached && detached ? ' but agents' : ''}.</div>}
    </div>
  );
}

function ChatRow({ item, color, openTicket }: { item: ListedChat; color?: string; openTicket(id: string): void }) {
  const { chat, ws, runsIn, ticket } = item;
  const target = { key: ws.key, chatId: chat.id };
  const state = listState(chat);
  const tip = [
    chat.title,
    chat.message && `“${chat.message}”`,
    `${STATE_LABEL[state]} · ${chat.age}`,
    chat.size?.tip,
    chat.detached && "One of Flotilla's agents: it works on its own",
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      class={`chat${state === 'ended' ? ' past' : ''}${chat.detached ? ' detached' : ''}${chat.unseen ? ' unseen' : ''}`}
      role="button"
      tabIndex={0}
      data-tip={tip}
      data-vscode-context={menuContext('chat', { key: ws.key, chatId: chat.id, flotillaWs: ws.context, linkedBy: chat.linkedBy })}
      onClick={() => run('flotilla.openChat', target)}
      onKeyDown={(e) => e.key === 'Enter' && run('flotilla.openChat', target)}
    >
      <i class={`codicon codicon-${STATE_ICON[state]} state`} />
      <span class="title">
        {chat.detached && <i class="codicon codicon-gear detached-mark" aria-label="detached" />}
        {chat.title}
      </span>
      {/* On hover they take the state word's place, so the ticket and the worktree chip stay clickable. */}
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        <button class="icon" aria-label={chat.open ? 'Open Chat' : 'Resume Chat'} onClick={() => run('flotilla.openChat', target)}>
          <i class="codicon codicon-link-external" />
        </button>
        <button class="icon" aria-label={`Unlink from ${ws.branch}`} onClick={() => run('flotilla.unlinkChat', target)}>
          <i class="codicon codicon-close" />
        </button>
      </span>
      <span class={`chat-state st-${state}`}>
        {chat.size?.big && <i class="codicon codicon-warning chat-size big" />}
        {STATE_LABEL[state]}
      </span>
      {ticket && ticket !== runsIn.label ? (
        <button class="link chat-ticket" data-tip={`Open ${ticket}`} onClick={(e) => (e.stopPropagation(), openTicket(ticket))}>
          {ticket}
        </button>
      ) : (
        <span />
      )}
      {/* The worktree's chip; when it's named after the ticket, it opens that ticket too, rather than say it twice. */}
      <span
        class={`chat-wt${ticket === runsIn.label ? ' chat-ticket' : ''}`}
        style={color ? { '--wt': color } : undefined}
        data-tip={ticket === runsIn.label ? `Runs in ${runsIn.branch} · Open ${ticket}` : `Runs in ${runsIn.branch}`}
        onClick={ticket === runsIn.label ? (e) => (e.stopPropagation(), openTicket(ticket)) : undefined}
      >
        {runsIn.label}
      </span>
    </div>
  );
}
