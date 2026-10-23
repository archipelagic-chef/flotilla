import type * as vscode from 'vscode';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import { setEventLog } from '../features/metrics/events';
import { historyImported, importHistory } from '../features/metrics/import';
import { rollUpOldEvents } from '../features/metrics/rollup';

/** How long after the window opens the leading window reads the history in and rolls old months up: out of the way. */
const SETTLE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Records this window's events in the main repository's git dir (BL-157). The leading window reads the history in
 * once, and rolls months older than a year up into their totals, a minute after it opens and then daily.
 */
export function startEventLog(o: { commonDir: string; mainRoot: string; backlog: LocalBacklog; isLeader: () => boolean; output: vscode.OutputChannel }): vscode.Disposable {
  setEventLog(o.commonDir, (line) => o.output.appendLine(line));
  const started = new Date();
  const upkeep = async () => {
    if (!o.isLeader()) return;
    try {
      await rollUpOldEvents(o.commonDir);
      if (historyImported(o.commonDir)) return;
      const ids = await o.backlog.ticketIds();
      const titles = new Map((await o.backlog.read()).items.map((i) => [i.id, i]));
      const tickets = await Promise.all(ids.map(async (id) => ({ id, ticket: await o.backlog.readTicket(titles.get(id) ?? { id, title: id }) })));
      const n = await importHistory({ commonDir: o.commonDir, mainRoot: o.mainRoot, tickets, before: started });
      if (n !== undefined) o.output.appendLine(`Read ${n} events in from the tickets' activity and git's merges.`);
    } catch (e) {
      o.output.appendLine(`The events' upkeep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const first = setTimeout(() => void upkeep(), SETTLE_MS);
  const daily = setInterval(() => void upkeep(), DAY_MS);
  return {
    dispose: () => {
      clearTimeout(first);
      clearInterval(daily);
      setEventLog(undefined);
    },
  };
}
