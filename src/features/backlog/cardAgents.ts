import type { BacklogItem } from './backlog';

/** What an agent on a ticket is doing, as its card shows it. */
export type CardAgentState = 'working' | 'waiting' | 'paused';

export interface CardAgent {
  name: string;
  state: CardAgentState;
}

/** A chat, as far as the card needs it: its state, and the agent and ticket its first line names (agentChatItem). */
export interface CardChat {
  state: 'working' | 'waiting-for-input' | 'done' | 'ended';
  agent?: { name: string; item: string };
}

export const CARD_AGENT_LABEL: Record<CardAgentState, string> = { working: 'working', waiting: 'waiting for input', paused: 'paused' };

// When an agent's chat shows up more than once (linked to several worktrees), the most pressing state wins.
const RANK: Record<CardAgentState, number> = { waiting: 0, working: 1, paused: 2 };

/**
 * The agents on a ticket, for its card (BL-96): each agent whose chat for it is working or waits for input, the agent
 * its review paused, and the implementer that asks the user something in the ticket. In the order they turn up;
 * none for a ticket without agents. Shared by the host and the webviews (no node or vscode APIs).
 */
export function cardAgents(item: Pick<BacklogItem, 'id' | 'review'>, chats: readonly CardChat[]): CardAgent[] {
  const found = new Map<string, CardAgentState>();
  const add = (name: string | undefined, state: CardAgentState) => {
    if (!name) return;
    const was = found.get(name);
    if (was === undefined || RANK[state] < RANK[was]) found.set(name, state);
  };
  for (const c of chats) {
    if (c.agent?.item !== item.id) continue;
    if (c.state === 'working') add(c.agent.name, 'working');
    else if (c.state === 'waiting-for-input') add(c.agent.name, 'waiting');
  }
  const r = item.review;
  // A paused agent's chat can still read as working for a moment: the review knows better.
  if (r?.state === 'paused' && r.paused?.agent) found.set(r.paused.agent, 'paused');
  if (r?.state === 'asking') add(r.implementer, 'waiting');
  return [...found].map(([name, state]) => ({ name, state }));
}
