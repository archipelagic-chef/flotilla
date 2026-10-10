import type { ChatState } from '../../features/chats/chats';
import type { ChatView, WorkstreamView } from '../protocol';
import { menuContext, run } from './api';
import type { Update } from './app';

const STATE_ICON: Record<ChatState, string> = {
  'waiting-for-input': 'bell-dot st-waiting',
  working: 'loading codicon-modifier-spin st-working',
  done: 'pass st-done',
  ended: 'history muted',
};

const STATE_LABEL: Record<ChatState, string> = {
  'waiting-for-input': 'waiting for you',
  working: 'working',
  done: 'finished',
  ended: 'ended',
};

interface Props {
  ws: WorkstreamView;
  historyOpen: boolean;
  update: Update;
}

/** Shown once above the chat lists while some worktree lacks the hooks that report chat state. */
export function HooksNotice({ missing }: { missing: number }) {
  if (!missing) return null;
  return (
    <div class="notice">
      <i class="codicon codicon-info" />
      <span>
        Install the Claude Code hooks to see which chats are working or waiting for you{missing > 1 ? ` (${missing} worktrees without them)` : ''}.
      </span>
      <button class="link" onClick={() => run('flotilla.installClaudeHooks')}>
        Install
      </button>
    </div>
  );
}

export function ChatsBody({ ws, historyOpen, update }: Props) {
  const open = ws.chats.filter((c) => c.open);
  const history = ws.chats.filter((c) => !c.open);
  const target = { key: ws.key };
  return (
    <div class="chats">
      {open.map((c) => (
        <ChatRow key={c.id} ws={ws} chat={c} />
      ))}
      <button class="row new-chat" onClick={() => run('flotilla.newChat', target)}>
        <i class="codicon codicon-add" />
        <span class="name">New chat</span>
      </button>
      {history.length > 0 && (
        <>
          <button
            class="row subhead"
            aria-expanded={historyOpen}
            onClick={() =>
              update((p) => ({ ...p, history: p.history.includes(ws.key) ? p.history.filter((k) => k !== ws.key) : [...p.history, ws.key] }))
            }
          >
            <i class={`codicon codicon-chevron-${historyOpen ? 'down' : 'right'} chev`} />
            <span class="name">History</span>
            <span class="badge">{history.length}</span>
          </button>
          {historyOpen && history.map((c) => <ChatRow key={c.id} ws={ws} chat={c} />)}
        </>
      )}
    </div>
  );
}

function ChatRow({ ws, chat }: { ws: WorkstreamView; chat: ChatView }) {
  const target = { key: ws.key, chatId: chat.id };
  const sub = chat.state === 'waiting-for-input' && chat.message ? `“${chat.message}”` : `${STATE_LABEL[chat.state]} · ${chat.age}`;
  return (
    <div
      class={`chat${chat.open ? '' : ' past'}`}
      role="button"
      tabIndex={0}
      data-tip={`${chat.title}\n${chat.open ? 'Open' : 'Resume'} this chat`}
      data-vscode-context={menuContext('chat', { key: ws.key, chatId: chat.id, flotillaWs: ws.context, linkedBy: chat.linkedBy })}
      onClick={() => run('flotilla.openChat', target)}
      onKeyDown={(e) => e.key === 'Enter' && run('flotilla.openChat', target)}
    >
      <i class={`codicon codicon-${STATE_ICON[chat.state]} state`} />
      <span class="title">
        {chat.title}
        {chat.via && (
          <span class="tag" data-tip={chat.linkedBy === 'edit' ? `Runs in ${chat.via} and edited files here` : `Runs in ${chat.via}; linked by hand`}>
            via {chat.via}
          </span>
        )}
      </span>
      <span class="hover-actions" onClick={(e) => e.stopPropagation()}>
        <button class="icon" aria-label={chat.open ? 'Open Chat' : 'Resume Chat'} onClick={() => run('flotilla.openChat', target)}>
          <i class="codicon codicon-link-external" />
        </button>
        <button class="icon" aria-label={`Unlink from ${ws.branch}`} onClick={() => run('flotilla.unlinkChat', target)}>
          <i class="codicon codicon-close" />
        </button>
      </span>
      <span class={`sub${chat.state === 'waiting-for-input' ? ' st-waiting' : ''}`}>{sub}</span>
    </div>
  );
}
