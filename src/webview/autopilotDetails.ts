import type { AutopilotQueued, AutopilotState } from './protocol';
import { runningFor } from './activeAgents';
import { shortTime } from './shortTime';

/** A line of the autopilot's details: it opens its ticket. */
export interface DetailLine {
  id: string;
  /** The ticket's title, when known. */
  title?: string;
  /** "Agent Nova-7 · working · 14 min", "a review · waits for a free agent". */
  text: string;
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

export function autopilotDetails(a: AutopilotState, titles: ReadonlyMap<string, string>, now = new Date()): AutopilotDetails {
  const title = (id: string) => (titles.has(id) ? { title: titles.get(id) } : {});
  const agents = (a.agents ?? []).map((g) => ({
    id: g.id,
    ...title(g.id),
    text: [g.agent ? `Agent ${g.agent}` : undefined, DOING[g.doing], g.since ? runningFor(g.since, now.getTime()) : undefined].filter(Boolean).join(' · '),
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
