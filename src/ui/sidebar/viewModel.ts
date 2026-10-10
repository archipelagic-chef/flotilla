import * as path from 'node:path';
import { samePath } from '../../core/paths';
import type { Chat } from '../../features/chats/chats';
import type { Workstream } from '../../features/workstreams/workstream';
import type { ChatView, WorkstreamView } from '../../webview/protocol';
import { ATTENTION_LABEL, describeSync, describeWorkstream, formatAge, syncKind, workstreamContext, workstreamLabel } from '../format';

/** Two letters for a rail tile: initials of the last branch segment's words ("feature/login-form" → "lf"), or its first two letters. */
export function initials(branch: string): string {
  const last = branch.split('/').filter(Boolean).pop() ?? branch;
  const words = last.split(/[-_.\s]+/).filter((w) => /^[a-z0-9]/i.test(w));
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toLowerCase();
  return (words[0] ?? last).slice(0, 2).toLowerCase() || '?';
}

/** "2m", "3h", "4d": the age of a chat's last activity. */
function chatAge(chat: Chat, now: Date): string {
  return formatAge(chat.updatedAt, now);
}

function chatVia(chat: Chat, all: readonly Workstream[]): string | undefined {
  if (!chat.cwd) return undefined;
  const ws = all.find((w) => w.worktree.path && samePath(w.worktree.path, chat.cwd!));
  return ws ? workstreamLabel(ws) : path.basename(chat.cwd);
}

export function toChatView(chat: Chat, all: readonly Workstream[], now: Date): ChatView {
  return {
    id: chat.id,
    title: chat.title,
    state: chat.state,
    message: chat.message,
    open: chat.open,
    linkedBy: chat.linkedBy,
    via: chat.linkedBy === 'cwd' ? undefined : chatVia(chat, all),
    age: chatAge(chat, now),
  };
}

export function toWorkstreamView(ws: Workstream, all: readonly Workstream[], now: Date, inWorkspace: boolean): WorkstreamView {
  const branch = workstreamLabel(ws);
  const sync = syncKind(ws);
  const tooltip = [branch, ws.worktree.path ?? `${ws.worktree.recordedPath} (not reachable from this environment)`, ATTENTION_LABEL[ws.attention]]
    .concat(ws.agent?.message ? [`“${ws.agent.message}”`] : [])
    .join('\n');
  return {
    key: ws.key,
    branch,
    initials: ws.worktree.isMain ? 'ma' : initials(branch),
    reachable: ws.worktree.path !== undefined,
    isMain: ws.worktree.isMain,
    isCurrent: ws.isCurrent,
    inWorkspace,
    attention: ws.attention,
    description: describeWorkstream(ws, now, inWorkspace),
    tooltip,
    staged: ws.staged,
    unstaged: ws.unstaged,
    sync: { kind: sync, text: describeSync(ws) || (sync === 'sync' ? 'up to date' : '') },
    chats: ws.chats.map((c) => toChatView(c, all, now)),
    hasHooks: ws.hasHooks,
    context: workstreamContext(ws, inWorkspace),
  };
}
