import type {
  SpendCell,
  SpendChat,
  SpendTimeline,
} from '../../webview/metricsProtocol';
import type { FlotillaEvent } from './events';
import type { LiveSpend } from './spendScan';
import {
  PURPOSE_LABEL,
  type SpendHour,
  type SpendPurpose,
} from './transcriptSpend';

/** How far back the timeline goes. */
export const TIMELINE_DAYS = 7;
const HOUR = 3_600_000;

interface Chat {
  info: SpendChat;
  title?: string;
  purposes: Set<SpendPurpose>;
  agent?: string;
}

/**
 * The chats' spend hour by hour over the last 7 days (BL-202): from the parts' hours (agent-spend events, and the
 * spend-hours read in for the parts recorded before they were kept), and the running chats' turns not recorded yet.
 */
export function spendTimeline(events: readonly FlotillaEvent[], now: number, live: readonly LiveSpend[] = []): SpendTimeline {
  const from = now - TIMELINE_DAYS * 24 * HOUR - HOUR;
  const chats = new Map<string, Chat>();
  const cells = new Map<string, Map<string, SpendCell & { purposeSet: Set<SpendPurpose> }>>();
  const add = (
    c: { session: string; ticket?: string; agent?: string; title?: string; cwd?: string; running?: boolean },
    purpose: SpendPurpose,
    hours: readonly SpendHour[] | undefined,
  ) => {
    const kept = (hours ?? []).filter((h) => Date.parse(h.at) >= from && Date.parse(h.at) <= now);
    let chat = chats.get(c.session);
    if (!chat) chats.set(c.session, (chat = { info: { id: c.session, label: '' }, purposes: new Set() }));
    if (c.ticket) chat.info.ticket ??= c.ticket;
    if (c.cwd) chat.info.cwd ??= c.cwd;
    if (c.agent) chat.agent ??= c.agent;
    if (c.title) chat.title = c.title;
    if (c.running) chat.info.running = true;
    if (!kept.length) return;
    chat.purposes.add(purpose);
    for (const h of kept) {
      let hour = cells.get(h.at);
      if (!hour) cells.set(h.at, (hour = new Map()));
      let cell = hour.get(c.session);
      if (!cell)
        hour.set(c.session, (cell = { chat: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0, purposes: [], purposeSet: new Set() }));
      cell.input += h.tokens.input;
      cell.output += h.tokens.output;
      cell.cacheRead += h.tokens.cacheRead;
      cell.cacheWrite += h.tokens.cacheCreation;
      cell.costUsd += h.costUsd;
      cell.turns += h.turns;
      cell.purposeSet.add(purpose);
    }
  };
  for (const e of events) {
    if (e.kind !== 'agent-spend' && e.kind !== 'spend-hours') continue;
    const d = (e as FlotillaEvent<'agent-spend' | 'spend-hours'>).data;
    add({ session: d.session, ticket: e.ticket, agent: e.agent, title: d.title, cwd: d.cwd }, d.purpose, d.hours);
  }
  for (const l of live) for (const p of l.parts) add({ ...l, running: true }, p.purpose, p.hours);

  const used = [...chats.entries()].filter(([, c]) => c.purposes.size);
  const index = new Map(used.map(([id], i) => [id, i]));
  return {
    chats: used.map(([, c]) => ({ ...c.info, label: chatLabel(c), ...(c.agent ? { agent: true as const } : {}) })),
    hours: [...cells.entries()]
      .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
      .map(([at, hour]) => ({
        at,
        cells: [...hour.entries()].map(([session, { purposeSet, ...cell }]) => ({
          ...cell,
          chat: index.get(session)!,
          costUsd: Math.round(cell.costUsd * 1e4) / 1e4,
          purposes: [...purposeSet].map((p) => PURPOSE_LABEL[p]),
        })),
      })),
  };
}

/** An agent's chat by its name and ticket ("reviewer Ziggy-8 · BL-201"); the user's own by its title. */
function chatLabel(c: Chat): string {
  if (c.agent) {
    const reviewer = c.purposes.has('review') && !c.purposes.has('first') && !c.purposes.has('rework');
    return `${reviewer ? 'reviewer ' : ''}${c.agent}${c.info.ticket ? ` · ${c.info.ticket}` : ''}`;
  }
  const title = c.title?.trim() || 'Untitled chat';
  return c.info.ticket && !title.includes(c.info.ticket) ? `${title} · ${c.info.ticket}` : title;
}
