import * as os from 'node:os';
import type * as vscode from 'vscode';
import { claudeHome } from '../features/chats/chats';
import type { LocalBacklog } from '../features/backlog/localBacklog';
import { setEventLog } from '../features/metrics/events';
import { historyImported, importHistory } from '../features/metrics/import';
import { rollUpOldEvents } from '../features/metrics/rollup';
import { scanSpend } from '../features/metrics/spendScan';

/** How long after the window opens the leading window reads the history in and rolls old months up: out of the way. */
const SETTLE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How often the leading window reads what the chats spent since (BL-189): a run's spend is in soon after it ends. */
const SPEND_SCAN_MS = 5 * 60_000;

/**
 * Records this window's events in the main repository's git dir (BL-157). The leading window reads the history in
 * once, and rolls months older than a year up into their totals, a minute after it opens and then daily. It reads
 * what the chats spent from their transcripts then, and every few minutes (the first time, all of their history).
 */
export function startEventLog(o: {
  commonDir: string;
  mainRoot: string;
  backlog: LocalBacklog;
  isLeader: () => boolean;
  output: vscode.OutputChannel;
}): vscode.Disposable {
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
  let scanning = false;
  const spend = async () => {
    if (!o.isLeader() || scanning) return;
    scanning = true;
    try {
      const n = await scanSpend({ commonDir: o.commonDir, mainRoot: o.mainRoot, home: claudeHome(), tmp: os.tmpdir() });
      if (n) o.output.appendLine(`Recorded ${n} parts of the chats' spend from their transcripts.`);
    } catch (e) {
      o.output.appendLine(`Reading the chats' spend failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      scanning = false;
    }
  };
  const first = setTimeout(() => void upkeep().then(spend), SETTLE_MS);
  const daily = setInterval(() => void upkeep(), DAY_MS);
  const scans = setInterval(() => void spend(), SPEND_SCAN_MS);
  return {
    dispose: () => {
      clearTimeout(first);
      clearInterval(daily);
      clearInterval(scans);
      setEventLog(undefined);
    },
  };
}
