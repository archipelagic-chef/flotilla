import {
  type AgentChoice,
  type BacklogItem,
  entryAgent,
} from './backlog';
import type { TicketEntry } from './ticket';
import { formatTokens } from '../chats/usage';

/**
 * Model levels (BL-69): agents run on the strong model (flotilla.agents.model) unless a ticket is Light (small and
 * mechanical: the user chose it, or the agent that proposed it said so), which runs on flotilla.agents.lightModel. A
 * ticket moves up to the strong model, never down, when it turns out hard: its review requests changes a second time,
 * or its agent says it needs a stronger model.
 */

/** The strong model when flotilla.agents.model is empty (Claude Code's default can't be ranked). */
export const STRONG_FALLBACK = 'opus';

/** The line an agent ends its report with when the work is too hard for the model it runs on. */
export const STRONGER_LINE = 'Needs a stronger model.';

/** The review rounds that may request changes before a lighter ticket moves up: the second request moves it. */
export const ROUNDS_BEFORE_MOVING_UP = 1;

/** How capable a model is, as far as its name tells (haiku < sonnet < opus); unknown names aren't ranked. */
export function modelRank(model: string | undefined): number | undefined {
  const m = model?.toLowerCase() ?? '';
  if (m.includes('haiku')) return 1;
  if (m.includes('sonnet')) return 2;
  if (m.includes('opus')) return 3;
  return undefined;
}

/** Whether a model is known to be weaker than another (unknown names are never weaker: nothing moves on a guess). */
export function weaker(model: string | undefined, than: string | undefined): boolean {
  const a = modelRank(model);
  const b = modelRank(than);
  return a !== undefined && b !== undefined && a < b;
}

/** The models a ticket's work can run on: the strong one (the settings') and the light one (empty: no ticket is light). */
export interface Levels {
  strong?: string;
  light?: string;
}

/** The model a ticket's implementing agents run: the ticket's own choice, else light when it's Light, else the strong one. */
export function workModel(agent: AgentChoice | undefined, levels: Levels): string | undefined {
  return agent?.model || (agent?.light && levels.light) || levels.strong || undefined;
}

/** The model a ticket's reviewers run: never the light one (a Light ticket is reviewed by the strong model). */
export function reviewModel(agent: AgentChoice | undefined, levels: Levels & { review?: string }): string | undefined {
  return levels.review || agent?.model || levels.strong || undefined;
}

/** Where a ticket's work would move up to, if it runs on a weaker model than the strong one; else undefined. */
export function moveUpTarget(agent: AgentChoice | undefined, levels: Levels): { from: string; to: string } | undefined {
  const from = workModel(agent, levels);
  const to = levels.strong || STRONG_FALLBACK;
  return from && weaker(from, to) ? { from, to } : undefined;
}

/** A ticket's choice once it moved up: the strong model, chosen for it, with the why kept. */
export function movedUp(agent: AgentChoice | undefined, move: { from: string; to: string }, reason: string, at: Date): AgentChoice {
  const { light: _light, ...rest } = agent ?? {};
  return { ...rest, model: move.to, movedUp: { from: move.from, to: move.to, reason, at: at.toISOString() } };
}

/** Whether a report asks for a stronger model: a line saying so (as the prompt asks, see lightNote). */
export function asksStrongerModel(body: string): boolean {
  return /^\s*\**\s*needs a stronger model\.?\s*\**\s*$/im.test(body);
}

/** What an agent on a lighter model is told: why, and how to ask for the strong one. */
export function lightNote(model: string, strong: string): string {
  return `This ticket runs on ${model}, a lighter model, because it looked small and mechanical. If it turns out harder than that (design decisions, a subtle bug, changes across many files, or you aren't sure your change is right), don't push on: stop, and end your report with the line "${STRONGER_LINE}" after saying why. Flotilla then goes on with your chat on ${strong}.`;
}

/** A finished ticket's level, as the report counts it. */
export function levelOf(item: Pick<BacklogItem, 'agent'>, levels: Levels): string {
  if (item.agent?.movedUp) return `moved up (${item.agent.movedUp.from} → ${item.agent.movedUp.to})`;
  return workModel(item.agent, levels) ?? "Claude Code's default";
}

/**
 * Per level: the finished tickets, their review rounds (average), what their agents re-read (average, of those whose
 * chats are still around: reRead, by ticket) and how many moved up. As lines, for the output.
 */
export function levelReport(items: readonly BacklogItem[], levels: Levels, reRead: ReadonlyMap<string, number> = new Map()): string[] {
  const done = items.filter((i) => i.status === 'done');
  const groups = new Map<string, BacklogItem[]>();
  for (const i of done) groups.set(levelOf(i, levels), [...(groups.get(levelOf(i, levels)) ?? []), i]);
  const lines = [`Model levels: ${done.length} finished tickets.`];
  for (const [level, its] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const reviewed = its.filter((i) => i.review?.round);
    const rounds = reviewed.length ? (reviewed.reduce((n, i) => n + i.review!.round, 0) / reviewed.length).toFixed(1) : '–';
    const counted = its.filter((i) => reRead.has(i.id));
    const tokens = counted.length ? `, ${formatTokens(counted.reduce((n, i) => n + reRead.get(i.id)!, 0) / counted.length)} tokens re-read on average` : '';
    lines.push(
      `  ${level}: ${its.length} ${its.length === 1 ? 'ticket' : 'tickets'}, ${rounds} review rounds on average${tokens} (${its.map((i) => i.id).join(', ')})`,
    );
  }
  const moved = done.filter((i) => i.agent?.movedUp);
  for (const i of moved) lines.push(`  ${i.id} moved up: ${i.agent!.movedUp!.reason}`);
  return lines;
}

/**
 * A ticket's latest entry, when it's an agent's report asking for a stronger model and wasn't seen before (handled: the
 * keys of entries already dealt with, or there when Flotilla started). Only the latest: a note after it (the move's)
 * means it was dealt with.
 */
export function strongerRequest(
  activity: readonly TicketEntry[],
  handled: readonly string[],
  key: (e: TicketEntry) => string,
): { entry: TicketEntry; agent: string } | undefined {
  const last = activity.at(-1);
  const agent = last && entryAgent(last.author);
  return last && agent && asksStrongerModel(last.body) && !handled.includes(key(last)) ? { entry: last, agent } : undefined;
}
