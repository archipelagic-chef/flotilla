import type { BacklogItemView, WorkstreamView } from '../../webview/protocol';

export type AgentState = 'running' | 'paused' | 'stopped';

/**
 * Where a ticket's agent is: running (in the review loop, or busy in one of its worktrees), paused, or stopped by the
 * user (it can be resumed).
 */
export function agentOf(item: BacklogItemView, worktrees: readonly WorkstreamView[]): AgentState | undefined {
  const state = item.review?.state;
  if (state === 'paused') return 'paused';
  if (state === 'stopped' && item.review?.stop?.kind === 'user' && item.review.stop.agent) return 'stopped';
  if (state === 'working' || state === 'reviewing' || state === 'revising') return 'running';
  return worktrees.some((w) => w.attention === 'working' || w.attention === 'waiting-for-input') ? 'running' : undefined;
}

/** Whether a ticket is being worked on, for the board's filter: its agent runs or is paused (it goes on later). */
export function hasActiveAgent(item: BacklogItemView, worktrees: readonly WorkstreamView[]): boolean {
  if (item.proposed) return false;
  const agent = agentOf(item, worktrees);
  return agent === 'running' || agent === 'paused';
}
