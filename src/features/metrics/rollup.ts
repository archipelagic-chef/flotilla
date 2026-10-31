import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  eventsDir,
  type FlotillaEvent,
  readEventsFile,
} from './events';

/** How many months of events are kept whole; older months are rolled up into their totals. */
export const KEEP_MONTHS = 12;

/** A month's totals: how many events of each kind, and the sums worth keeping (tokens, cost, minutes). */
export interface MonthTotals {
  month: string;
  counts: Record<string, number>;
  /** Per agent role: runs, minutes, cost and tokens of the agents that ended. */
  agents: Record<string, { runs: number; minutes: number; costUsd: number; tokens: number }>;
  /** Merges that conflicted, their regions, and those regions that only added lines. */
  conflicts: { merges: number; regions: number; additions: number };
}

export function monthTotals(month: string, events: readonly FlotillaEvent[]): MonthTotals {
  const t: MonthTotals = { month, counts: {}, agents: {}, conflicts: { merges: 0, regions: 0, additions: 0 } };
  for (const e of events) {
    t.counts[e.kind] = (t.counts[e.kind] ?? 0) + 1;
    if (e.kind === 'agent-ended') {
      const d = (e as FlotillaEvent<'agent-ended'>).data;
      const a = (t.agents[d.role] ??= { runs: 0, minutes: 0, costUsd: 0, tokens: 0 });
      a.runs++;
      a.minutes += d.minutes || 0;
      a.costUsd += d.costUsd ?? 0;
      a.tokens += d.tokens ? d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheCreation : 0;
    }
    if (e.kind === 'merge-conflicted') {
      const regions = (e as FlotillaEvent<'merge-conflicted'>).data.files.flatMap((f) => f.regions);
      t.conflicts.merges++;
      t.conflicts.regions += regions.length;
      t.conflicts.additions += regions.filter((r) => r.additions).length;
    }
  }
  return t;
}

export function addTotals(a: MonthTotals, b: MonthTotals | undefined): MonthTotals {
  if (!b) return a;
  const counts = { ...b.counts };
  for (const [k, n] of Object.entries(a.counts)) counts[k] = (counts[k] ?? 0) + n;
  const agents = { ...b.agents };
  for (const [role, x] of Object.entries(a.agents)) {
    const y = agents[role] ?? { runs: 0, minutes: 0, costUsd: 0, tokens: 0 };
    agents[role] = { runs: x.runs + y.runs, minutes: x.minutes + y.minutes, costUsd: x.costUsd + y.costUsd, tokens: x.tokens + y.tokens };
  }
  const c = b.conflicts ?? { merges: 0, regions: 0, additions: 0 };
  return {
    month: a.month,
    counts,
    agents,
    conflicts: { merges: a.conflicts.merges + c.merges, regions: a.conflicts.regions + c.regions, additions: a.conflicts.additions + c.additions },
  };
}

/** The first month kept whole at now: the months before it are rolled up. */
export function firstKeptMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (KEEP_MONTHS - 1), 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Rolls the months older than KEEP_MONTHS up into `totals-YYYY-MM.json` and removes their events. The totals are
 * written (whole, by a rename) before the events go, so a crash between leaves the events to roll up again. Returns
 * the months rolled up.
 */
export async function rollUpOldEvents(commonDir: string, now = new Date()): Promise<string[]> {
  const dir = eventsDir(commonDir);
  const keep = firstKeptMonth(now);
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  const done: string[] = [];
  for (const n of names.sort()) {
    const month = /^events-(\d{4}-\d{2})\.jsonl$/.exec(n)?.[1];
    if (!month || month >= keep) continue;
    const file = path.join(dir, n);
    const out = path.join(dir, `totals-${month}.json`);
    // Events written to a month already rolled up (late, or imported) are added to its totals.
    const before = await fs.promises.readFile(out, 'utf8').then(
      (t) => JSON.parse(t) as MonthTotals,
      () => undefined,
    );
    const totals = addTotals(monthTotals(month, await readEventsFile(file)), before);
    const tmp = `${out}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify(totals, null, 1)}\n`);
    await fs.promises.rename(tmp, out);
    await fs.promises.rm(file, { force: true });
    done.push(month);
  }
  return done;
}
