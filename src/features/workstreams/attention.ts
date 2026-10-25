import type { ActivityLevel } from './activity';
import type { AgentStatus } from './agentStatus';

export type AttentionState = 'waiting-for-input' | 'error' | 'working' | 'done' | 'active' | 'idle' | 'stale' | 'unreachable';

export const ATTENTION_ORDER: readonly AttentionState[] = ['waiting-for-input', 'error', 'working', 'done', 'active', 'idle', 'stale', 'unreachable'];

export interface AttentionInput {
  reachable: boolean;
  agent: AgentStatus | undefined;
  activity: ActivityLevel;
  now: Date;
  agentStaleMinutes: number;
}

export function computeAttention(input: AttentionInput): { state: AttentionState; agentStale: boolean } {
  if (!input.reachable) return { state: 'unreachable', agentStale: false };
  if (!input.agent) return { state: input.activity, agentStale: false };
  const agentStale = input.now.getTime() - input.agent.updatedAt.getTime() > input.agentStaleMinutes * 60_000;
  if (input.agent.state === 'working' && agentStale) return { state: input.activity, agentStale: true };
  return { state: input.agent.state, agentStale };
}

export function sortByAttention<T extends { attention: AttentionState; lastActivity?: Date }>(items: readonly T[]): T[] {
  const rank = (a: AttentionState) => ATTENTION_ORDER.indexOf(a);
  return [...items].sort((a, b) => rank(a.attention) - rank(b.attention) || (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0));
}
