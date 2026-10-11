import type { Scope } from '../../core/repository';
import type { Workstream } from './workstream';

/** How often a worktree nobody is working in is rebuilt (its changes still show at once when git or a save names it). */
export const IDLE_REFRESH_MS = 3 * 60_000;

/** Timers fire a little late; a rebuild this close to its time still counts as due. */
const SLACK_MS = 1000;

/** Someone is working in this worktree: a window is open or it's the sidebar's pick, an agent runs, or its files changed lately. */
export function isLive(ws: Workstream, activeKey: string | undefined): boolean {
  const agentRunning = ws.agent?.state === 'working' || ws.agent?.state === 'waiting-for-input';
  return ws.isCurrent || ws.windowOpen || agentRunning || ws.activity === 'active' || ws.key === activeKey;
}

/**
 * Whether a refresh rebuilds this worktree: it has never been built, the scope names it (or everything), or it's due
 * by its schedule. Live worktrees are due every `pollMs`; the others every `IDLE_REFRESH_MS`.
 */
export function isRebuildDue(
  prev: Workstream | undefined,
  scope: Scope,
  now: number,
  pollMs: number,
  activeKey: string | undefined,
): boolean {
  if (!prev || scope === 'all' || scope.has(prev.key)) return true;
  const interval = isLive(prev, activeKey) ? pollMs : IDLE_REFRESH_MS;
  return now - prev.refreshedAt >= interval - SLACK_MS;
}
