/** A ticket tab's messages about its agents: start one, their model and effort, pause or stop them, open their chats: handled in ./agents.ts. Type-only, as ticketProtocol.ts. */
import type { AgentEffort } from '../../../features/backlog/backlog';

export type AgentsMessage =
  /** Create (or show) the item's worktree; with agent, also start an agent there. */
  | { type: 'start'; agent: boolean; /** The Create Worktree button: a new worktree at once, named without asking or in a box. */ newWorktree?: 'auto' | 'named' }
  /** Pause, stop or resume an agent: the one with that chat, else the one working on it. */
  | { type: 'agent'; action: 'pause' | 'stop' | 'resume'; session?: string }
  /** The model and effort agents use on it: null is the default; 'other' asks for a model's name. */
  | { type: 'agentModel'; model: string | null }
  | { type: 'agentEffort'; effort: AgentEffort | null }
  /** Open an agent's chat in Claude Code. */
  | { type: 'openChat'; key: string; id: string };
