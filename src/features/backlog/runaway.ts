import type { ChatUsage } from '../chats/chats';
import { formatTokens } from '../chats/usage';

/**
 * Runaway agents (BL-76): an agent that runs the same failing command again and again with nothing changed in between
 * is going round in circles, and one far past what tickets take burns tokens a person should look at first.
 */

/** Failures of the same command in a row, with no edit in between, that stop an agent. */
export const STUCK_FAILS = 4;

/** Why an agent should stop now (its token use now, and when it started), or undefined. budget: re-read tokens; 0: none. */
export function runawayReason(now: ChatUsage, base: ChatUsage, budget: number): string | undefined {
  if (now.failStreak >= base.failStreak + STUCK_FAILS) return `the same command failed ${now.failStreak} times in a row, with no change in between`;
  const used = now.reRead - base.reRead;
  if (budget > 0 && used > budget) return `it re-read ${formatTokens(used)} tokens since it started, past flotilla.agents.tokenBudget (${formatTokens(budget)})`;
  return undefined;
}

/** What a stopped agent is told when it's resumed: step back before going on. */
export function runawayPrompt(why: string): string {
  return `Flotilla stopped you: ${why}. Before you go on, step back: write in the ticket what you tried and what's in the way, then take another approach, or ask (as your instructions say) if you need a decision.`;
}

export const NO_USAGE: ChatUsage = { turns: 0, context: 0, reRead: 0, written: 0, output: 0, failStreak: 0 };
