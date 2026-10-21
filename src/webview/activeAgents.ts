import type { TicketView } from './ticketProtocol';

/** "12 min", "1 h 5 min", "2 d 3 h": how long since then. */
export function runningFor(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(m / 1440)} d${Math.floor(m / 60) % 24 ? ` ${Math.floor(m / 60) % 24} h` : ''}`;
}

/** The agents on the ticket now: busy (working, or waiting for you) or paused by you. */
export function activeAgents(agents: TicketView['agents']): TicketView['agents'] {
  return agents.filter((a) => a.held === 'paused' || (!a.held && a.runs));
}

/** The summary of an agent's latest report (rendered), and when it wrote it. */
export function lastReport(activity: TicketView['activity'], id: string): { html: string; date: string } | undefined {
  for (let n = activity.length - 1; n >= 0; n--) {
    const e = activity[n];
    if (e.author === 'Flotilla' || !e.chat || 'pending' in e.chat || e.chat.id !== id) continue;
    return { html: e.report?.summary ?? e.html, date: e.date };
  }
  return undefined;
}
