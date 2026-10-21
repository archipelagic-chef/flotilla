import * as fs from 'node:fs';
import * as path from 'node:path';
import { conflictRegions } from '../../core/git/conflictRegions';
import { runGit } from '../../core/git/gitCli';
import { entryAgent } from '../backlog/backlog';
import { parseVerdict } from '../backlog/review';
import type { Ticket } from '../backlog/ticket';
import { appendEvents, eventsDir, type EventData, type EventKind, type FlotillaEvent } from './events';

/**
 * The history from before the events were recorded, read in once (BL-157) so the metrics aren't empty on the first
 * day: the lane moves, agent starts, verdicts and merges the tickets' activity notes, and the merges' conflicts
 * replayed from git (as BL-155 measured them). Every event read in is marked `imported`.
 */
const IMPORTED_MARK = 'imported';

const LANES: Record<string, string> = { 'To Do': 'todo', 'In Progress': 'doing', 'In Review': 'review', Done: 'done' };

/** An entry's "YYYY-MM-DD HH:MM" (local time), as a Date; undefined when it isn't one. */
function entryTime(date: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(date.trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : undefined;
}

/** Who a Flotilla note says did a change: "You", "The autopilot", "Nova-7 (an agent)", or Flotilla. */
function noteBy(sentence: string): string {
  if (/^You\b/.test(sentence)) return 'You';
  if (/^The autopilot\b/.test(sentence)) return 'Autopilot';
  const agent = /^([A-Za-z0-9-]+) \(an agent\)/.exec(sentence)?.[1];
  return agent ? `Agent ${agent}` : 'Flotilla';
}

/** The events a ticket's activity tells of. */
export function eventsFromTicket(id: string, ticket: Pick<Ticket, 'activity'>): FlotillaEvent[] {
  const out: FlotillaEvent[] = [];
  const push = <K extends EventKind>(kind: K, at: Date, data: EventData[K], agent?: string) =>
    out.push({ at: at.toISOString(), kind, ticket: id, ...(agent ? { agent } : {}), data, imported: true });
  let round = 0;
  for (const e of ticket.activity) {
    const at = entryTime(e.date);
    if (!at) continue;
    const agent = entryAgent(e.author);
    if (agent) {
      const verdict = parseVerdict(e.body);
      if (verdict) push('review-verdict', at, { verdict, round: ++round, by: agent }, agent);
      continue;
    }
    if (e.author === 'You') {
      const verdict = parseVerdict(e.body);
      if (verdict) push('review-verdict', at, { verdict, round: ++round, by: 'You' });
      continue;
    }
    if (e.author !== 'Flotilla') continue;
    for (const s of e.body.split(/\n\s*\n/).map((p) => p.trim())) {
      const moved = /moved it from \*\*(.+?)\*\* to \*\*(.+?)\*\*/i.exec(s);
      if (moved && LANES[moved[1]] && LANES[moved[2]]) push('ticket-moved', at, { from: LANES[moved[1]], to: LANES[moved[2]], by: noteBy(s) });
      const opened = /opened a chat for agent ([A-Za-z0-9-]+)(?: \(([a-z0-9.-]+)\))?/.exec(s);
      if (opened) {
        const role = /^Merging /.test(s) ? 'merge' : /review/i.test(s.slice(0, opened.index)) ? 'review' : 'work';
        push('agent-started', at, { role, session: '', ...(opened[2] ? { model: opened[2] } : {}) }, opened[1]);
      }
      const resumed = /resumed (?:a|the) chat for agent ([A-Za-z0-9-]+)/.exec(s);
      if (resumed) {
        push('agent-resumed', at, { role: /^Merging /.test(s) ? 'merge' : 'work', session: '' }, resumed[1]);
        const tries = /^The limit reset(?: after (\d+) tries)?/.exec(s);
        if (tries) push('limit-lifted', at, tries[1] ? { tries: +tries[1] } : {});
      }
      const merged = /merged it into \*\*(.+?)\*\* \(([0-9a-f]{7,40})\)/i.exec(s);
      if (merged) push('merge-landed', at, { into: merged[1], commit: merged[2] });
      const stopped = /^Merging `?(.+?)`? into `?(.+?)`? stopped: (.*)$/s.exec(s);
      if (stopped) {
        if (/checks? failed/.test(stopped[3])) push('merge-checks-failed', at, { failure: /time[sd]? out/.test(stopped[3]) ? 'timeout' : 'other', tests: [] });
        else push('merge-cancelled', at, { reason: stopped[3].split('\n')[0].slice(0, 200) });
      }
    }
  }
  return out;
}

/** The ticket id a merge's subject names: "Merge BL-148: …", "Merge branch 'main' into feature/BL-148-…". */
function ticketOfMerge(subject: string): string | undefined {
  return /\b([A-Z][A-Z0-9]{0,9}-\d{1,7})\b/.exec(subject)?.[1];
}

/**
 * The merges of a repository's history replayed (BL-155): each merge commit's parents merged again in memory; those
 * that conflicted give a merge-conflicted event, with their files and regions. since limits the merges to later ones.
 */
export async function replayMerges(cwd: string, o: { since?: string; ref?: string } = {}): Promise<FlotillaEvent[]> {
  const log = await runGit(['log', '--merges', '--format=%H %P%x09%cI%x09%s', ...(o.since ? [`--since=${o.since}`] : []), o.ref ?? 'HEAD'], { cwd, timeoutMs: 120_000 });
  const out: FlotillaEvent[] = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [shas, at, subject = ''] = line.split('\t');
    const [, ours, theirs] = shas.split(' ');
    if (!ours || !theirs) continue;
    const files = await conflictRegions(cwd, ours, theirs).catch(() => []);
    if (!files.length) continue;
    const ticket = ticketOfMerge(subject);
    out.push({ at: new Date(at).toISOString(), kind: 'merge-conflicted', ...(ticket ? { ticket } : {}), data: { files }, imported: true });
  }
  return out.reverse();
}

/** Whether the history was read in (or is being read in) already. */
export function historyImported(commonDir: string): boolean {
  return fs.existsSync(path.join(eventsDir(commonDir), IMPORTED_MARK));
}

/**
 * Reads the history in, once per repository: the tickets' activity and the merges of the main branch. Later calls
 * do nothing (a mark next to the events says it's done). Returns how many events it read in, or undefined when it was
 * done before. before: when recording started (what happened since isn't read in).
 */
export async function importHistory(o: { commonDir: string; mainRoot: string; tickets: { id: string; ticket: Pick<Ticket, 'activity'> }[]; ref?: string; before?: Date }): Promise<number | undefined> {
  const mark = path.join(eventsDir(o.commonDir), IMPORTED_MARK);
  if (historyImported(o.commonDir)) return undefined;
  await fs.promises.mkdir(eventsDir(o.commonDir), { recursive: true });
  // Taken first, so two windows don't both read it in: the second finds the mark.
  try {
    await fs.promises.writeFile(mark, `${new Date().toISOString()}\n`, { flag: 'wx' });
  } catch {
    return undefined;
  }
  const events = o.tickets.flatMap((t) => eventsFromTicket(t.id, t.ticket));
  // The merges of the months kept whole (older ones would be rolled up at once).
  events.push(...(await replayMerges(o.mainRoot, { ref: o.ref, since: new Date(Date.now() - 365 * 86_400_000).toISOString() }).catch(() => [])));
  // What happened since recording started is recorded already.
  const before = o.before?.toISOString();
  const old = events.filter((e) => !before || e.at < before).sort((a, b) => a.at.localeCompare(b.at));
  await appendEvents(o.commonDir, old);
  return old.length;
}
