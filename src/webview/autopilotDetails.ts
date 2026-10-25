import type { AutopilotQueued, AutopilotState } from './protocol';
import { runningFor } from './activeAgents';
import { shortTime } from './shortTime';
import type { CardAgent } from '../features/backlog/cardAgents';
import { statusLine } from '../features/chats/activity';

/** A line of the autopilot's details: it opens its ticket. */
export interface DetailLine {
  id: string;
  /** The ticket's title, when known. */
  title?: string;
  /** "Agent Nova-7 · working · 14 min", "a review · waits for a free agent". */
  text: string;
  /** What the agent is doing now, from its transcript (BL-175): "Running `npm test` · 2:10 · 4 of 7", or why it looks stuck. */
  status?: string;
  stuck?: boolean;
  /** An agent listed but not counted (BL-201): its line says why. */
  uncounted?: boolean;
}

/** What the autopilot's details show (BL-153): the agents working, the starts waiting in order and why, why it's idle, the limit. */
export interface AutopilotDetails {
  agents: DetailLine[];
  waiting: DetailLine[];
  idle?: string;
  running: number;
  max: number;
  /** Try Now: it waits for a usage limit. */
  tryNow: boolean;
}

const DOING = {
  work: 'working',
  review: 'reviewing',
  starting: 'starting',
} as const;
const KIND: Record<AutopilotQueued['kind'], string> = {
  reply: 'your reply',
  review: 'a review',
  resume: 'resuming',
  new: 'a new ticket',
};

/** Why a start waits: a usage limit (until when) before memory, memory before the limit of agents. */
function why(q: AutopilotQueued, a: AutopilotState, now: Date): string {
  if (a.waitingUntil) return `waits for Claude's usage limit (until ${shortTime(a.waitingUntil, now)})`;
  if (q.reason === 'memory') return 'waits for free memory';
  return `waits for a free agent (the limit, ${a.max})`;
}

/** The status of the agent working on a ticket, from the agents its card shows. */
function liveStatus(agents: readonly CardAgent[] | undefined, name: string | undefined, now: Date): Pick<DetailLine, 'status' | 'stuck'> {
  const g = agents?.find((c) => c.activity && (!name || c.name.toLowerCase() === name.toLowerCase()));
  if (!g?.activity) return {};
  if (g.stuck) return { status: `Looks stuck: ${g.stuck}`, stuck: true };
  const line = statusLine(g.activity, now.getTime());
  return line ? { status: line } : {};
}

export function autopilotDetails(
  a: AutopilotState,
  titles: ReadonlyMap<string, string>,
  now = new Date(),
  live: ReadonlyMap<string, readonly CardAgent[]> = new Map(),
): AutopilotDetails {
  const title = (id: string) => (titles.has(id) ? { title: titles.get(id) } : {});
  const agents = (a.agents ?? []).map((g) => ({
    id: g.id,
    ...title(g.id),
    text: [
      g.agent ? `Agent ${g.agent}` : undefined,
      g.uncounted ? `not counted: ${g.uncounted}` : DOING[g.doing],
      g.since && !g.uncounted ? runningFor(g.since, now.getTime()) : undefined,
      g.held && !g.uncounted ? `${g.held} by you, but its process still runs` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    ...(g.uncounted ? { uncounted: true } : {}),
    ...(g.doing === 'starting' || g.uncounted ? {} : liveStatus(live.get(g.id), g.agent, now)),
  }));
  const waiting = (a.queue ?? []).map((q) => ({
    id: q.id,
    ...title(q.id),
    text: `${KIND[q.kind]} · ${why(q, a, now)}${q.since ? ` · ${runningFor(q.since, now.getTime())}` : ''}`,
  }));
  return {
    agents,
    waiting,
    ...(a.idle && !a.waitingUntil ? { idle: a.idle } : {}),
    running: a.running,
    max: a.max,
    tryNow: !!a.waitingUntil && !a.elsewhere,
  };
}
