import type { CompareMode } from '../features/diffs/compare';
import type { AttentionState } from '../features/workstreams/attention';
import type { Workstream } from '../features/workstreams/workstream';

export function formatAge(date: Date | undefined, now: Date): string {
  if (!date) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const ATTENTION_LABEL: Record<AttentionState, string> = {
  'waiting-for-input': 'waiting for input',
  error: 'error',
  working: 'working',
  done: 'done',
  active: 'active',
  idle: 'idle',
  stale: 'stale',
  unreachable: 'unreachable from this environment',
};

export const COMPARE_MODE_LABEL: Record<CompareMode, string> = {
  mergeBase: 'since merge-base',
  twoDot: 'two-dot',
  uncommitted: 'incl. uncommitted',
};

const FROM_AGENT: ReadonlySet<AttentionState> = new Set(['waiting-for-input', 'error', 'working', 'done']);

export function workstreamLabel(ws: Workstream): string {
  return ws.worktree.branch ?? `detached @ ${ws.worktree.head?.slice(0, 7) ?? 'unknown'}`;
}

/** Upstream state, e.g. "unpublished" or "2 to push, 1 to pull"; empty when there is nothing to say. */
export function describeSync(ws: Workstream): string {
  const s = ws.sync;
  if (!ws.worktree.branch) return '';
  if (!s.upstream) return s.hasRemote ? 'unpublished' : '';
  return [s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} to pull` : ''].filter(Boolean).join(', ');
}

/** Which sync action applies: publish an unpublished branch, sync a tracking one, or none. */
export function syncKind(ws: Workstream): 'publish' | 'sync' | 'none' {
  if (!ws.worktree.branch) return 'none';
  if (ws.sync.upstream) return 'sync';
  return ws.sync.hasRemote ? 'publish' : 'none';
}

export function describeWorkstream(ws: Workstream, now: Date, inWorkspace = false): string {
  if (ws.attention === 'unreachable') return ATTENTION_LABEL.unreachable;
  const fromAgent = FROM_AGENT.has(ws.attention) && ws.agent !== undefined;
  const since = fromAgent ? ws.agent?.updatedAt : ws.lastActivity;
  const parts = [`${ATTENTION_LABEL[ws.attention]}${fromAgent && ws.agentStale ? ' (last reported)' : ''} · ${formatAge(since, now)}`];
  const p = ws.progress;
  if (p) {
    const counts = [p.ahead ? `↑${p.ahead}` : '', p.behind ? `↓${p.behind}` : '', p.added || p.deleted ? `+${p.added} −${p.deleted}` : '']
      .filter(Boolean)
      .join(' ');
    if (counts) parts.push(counts);
  }
  const sync = describeSync(ws);
  if (sync) parts.push(sync);
  if (ws.isCurrent) parts.push('this window');
  else if (inWorkspace) parts.push('in workspace');
  else if (ws.windowOpen && ws.heartbeat) parts.push(`open in ${ws.heartbeat.env}`);
  if (ws.worktree.isMain) parts.unshift('main worktree');
  return parts.join(' · ');
}

/** Tokens are matched by regex in package.json when-clauses (e.g. `viewItem =~ /;linked;/`); append new ones at the end. */
export function workstreamContext(ws: Workstream, inWorkspace = false): string {
  const wt = ws.worktree;
  const sync = syncKind(ws);
  return [
    'workstream',
    wt.path ? 'reachable' : 'unreachable',
    ws.isCurrent ? 'current' : 'notCurrent',
    wt.isMain ? 'main' : 'linked',
    wt.portable ? 'portable' : 'notPortable',
    ws.agent ? 'hasAgent' : 'noAgent',
    ws.staged.length ? 'hasStaged' : 'noStaged',
    ws.unstaged.length ? 'hasUnstaged' : 'noUnstaged',
    sync === 'publish' ? 'publishable' : sync === 'sync' ? 'tracking' : 'noSync',
    inWorkspace ? 'inWorkspace' : 'notInWorkspace',
    '',
  ].join(';');
}
