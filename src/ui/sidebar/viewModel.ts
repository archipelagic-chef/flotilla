import * as path from 'node:path';
import { samePath } from '../../core/paths';
import { agentChatItem } from '../../features/backlog/backlog';
import {
  awaiting,
  type Chat,
} from '../../features/chats/chats';
import {
  DEFAULT_STUCK_RULES,
  health,
  type StuckRules,
} from '../../features/chats/activity';
import type { Workstream } from '../../features/workstreams/workstream';
import type { FileChange } from '../../core/git/porcelain';
import {
  BIG_CHAT_HINT,
  formatTokens,
  usageTip,
} from '../../features/chats/usage';
import type {
  ChatView,
  FileChangeView,
  WorkstreamView,
} from '../../webview/protocol';
import { tabLabel } from './tabLabel';
import {
  ATTENTION_LABEL,
  describeSync,
  describeWorkstream,
  formatAge,
  syncKind,
  workstreamContext,
  workstreamLabel,
} from '../format';

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

export function toChatView(chat: Chat, all: readonly Workstream[], now: Date, bigContext = 200_000, rules: StuckRules = DEFAULT_STUCK_RULES): ChatView {
  const u = chat.usage;
  const live = chat.state === 'working' && !chat.stalled ? chat.activity : undefined;
  const h = live && health(live, chat.updatedAt.toISOString(), rules, true, now.getTime());
  const big = !!u && bigContext > 0 && u.context >= bigContext;
  const agent = agentChatItem(chat.firstPrompt);
  return {
    id: chat.id,
    title: chat.title,
    state: chat.state,
    message: chat.message,
    open: chat.open,
    ...(chat.stalled ? { stalled: true } : {}),
    ...(awaiting(chat) ? { awaiting: awaiting(chat) } : {}),
    linkedBy: chat.linkedBy,
    via: chat.linkedBy === 'cwd' ? undefined : chatVia(chat, all),
    age: chatAge(chat, now),
    ...(agent ? { agent: { name: agent.agent, item: agent.item } } : {}),
    ...(u?.context ? { size: { label: formatTokens(u.context), tip: big ? `${usageTip(u)} ${BIG_CHAT_HINT}` : usageTip(u), big } } : {}),
    ...(live ? { activity: live } : {}),
    ...(h?.stuck ? { stuck: h.text } : {}),
  };
}

/** The first `limit` changes of a list (what the sidebar sends), and how many there are in all. */
export function capChanges(changes: readonly FileChange[], limit: number): { items: FileChangeView[]; total: number } {
  return { items: changes.slice(0, Math.max(0, Math.floor(limit))), total: changes.length };
}

/**
 * The views that differ from the ones last sent (by key, as JSON), and every key in order. `sent` is updated to match,
 * so the next call compares against what the webview now holds.
 */
export function changedViews(views: readonly WorkstreamView[], sent: Map<string, string>): { changed: WorkstreamView[]; keys: string[] } {
  const changed: WorkstreamView[] = [];
  const next = new Map<string, string>();
  for (const view of views) {
    const json = JSON.stringify(view);
    next.set(view.key, json);
    if (sent.get(view.key) !== json) changed.push(view);
  }
  sent.clear();
  for (const [key, json] of next) sent.set(key, json);
  return { changed, keys: views.map((v) => v.key) };
}

export function toWorkstreamView(
  ws: Workstream,
  all: readonly Workstream[],
  now: Date,
  inWorkspace: boolean,
  labelPattern: string | undefined,
  changesLimit: number,
  bigContext = 200_000,
  rules: StuckRules = DEFAULT_STUCK_RULES,
): WorkstreamView {
  // The limit is per worktree, across both lists: staged changes first (they're what a commit takes).
  const staged = capChanges(ws.staged, changesLimit);
  const unstaged = capChanges(ws.unstaged, changesLimit - staged.items.length);
  const branch = workstreamLabel(ws);
  const sync = syncKind(ws);
  const tooltip = [branch, ws.worktree.path ?? `${ws.worktree.recordedPath} (not reachable from this environment)`, ATTENTION_LABEL[ws.attention]]
    .concat(ws.agent?.message ? [`“${ws.agent.message}”`] : [])
    .join('\n');
  return {
    key: ws.key,
    branch,
    label: ws.worktree.isMain ? branch : tabLabel(branch, labelPattern),
    initials: ws.worktree.isMain ? 'ma' : initials(branch),
    reachable: ws.worktree.path !== undefined,
    isMain: ws.worktree.isMain,
    isCurrent: ws.isCurrent,
    inWorkspace,
    attention: ws.attention,
    description: describeWorkstream(ws, now, inWorkspace),
    tooltip,
    path: ws.worktree.path ?? ws.worktree.recordedPath ?? '',
    agentMessage: ws.agent?.message || undefined,
    staged: staged.items,
    unstaged: unstaged.items,
    totals: { staged: staged.total, unstaged: unstaged.total },
    sync: { kind: sync, text: describeSync(ws) || (sync === 'sync' ? 'up to date' : ''), ahead: ws.sync.ahead, behind: ws.sync.behind, head: ws.sync.head },
    chats: ws.chats.map((c) => toChatView(c, all, now, bigContext, rules)),
    hasHooks: ws.hasHooks,
    context: workstreamContext(ws, inWorkspace),
  };
}

/** Tab order: the main worktree first, then by branch. Stable, unlike the attention order, so tabs don't jump. */
export function tabOrder<T extends Workstream>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(b.worktree.isMain) - Number(a.worktree.isMain) || workstreamLabel(a).localeCompare(workstreamLabel(b)));
}
