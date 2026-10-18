import type { ChatUsage } from './chats';

/** Tokens, short: 950, 12k, 3.4M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A chat's token use, for its tooltip. */
export function usageTip(u: ChatUsage): string {
  return `Re-reads ${formatTokens(u.context)} tokens on every turn. So far: ${u.turns} turns, ${formatTokens(u.reRead)} re-read, ${formatTokens(u.written)} written, ${formatTokens(u.output)} output.`;
}

/** What a big chat's tooltip adds: how to make its turns cheaper. */
export const BIG_CHAT_HINT = 'For a new topic, a new chat is much cheaper; to go on with this one, /compact keeps a summary and drops the rest.';

/** Several chats' token use, added up (a ticket's agents); context is the largest one's. */
export function addUsage(all: ReadonlyArray<ChatUsage | undefined>): ChatUsage | undefined {
  const some = all.filter((u): u is ChatUsage => !!u);
  if (!some.length) return undefined;
  return some.reduce((a, b) => ({
    turns: a.turns + b.turns,
    context: Math.max(a.context, b.context),
    reRead: a.reRead + b.reRead,
    written: a.written + b.written,
    output: a.output + b.output,
    failStreak: Math.max(a.failStreak, b.failStreak),
  }));
}
