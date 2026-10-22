// Records an event for Flotilla's metrics (BL-157) from a script: one JSON line appended to
// <commonDir>/flotilla/metrics/events-YYYY-MM.jsonl, as src/features/metrics/events.ts writes them. It never throws:
// a script's work doesn't depend on its event.
import fs from 'node:fs';
import path from 'node:path';

/** The ticket a branch is for ("feature/BL-157-…" is BL-157), if it names one. */
export function ticketOfBranch(branch) {
  return /\b([A-Z][A-Z0-9]{0,9}-\d{1,7})\b/.exec(branch ?? '')?.[1];
}

export function recordEvent(commonDir, kind, { ticket, agent, data, at = new Date() } = {}) {
  if (!commonDir) return false;
  try {
    const dir = path.join(commonDir, 'flotilla', 'metrics');
    const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    fs.mkdirSync(dir, { recursive: true });
    const event = { at: at.toISOString(), kind, ...(ticket ? { ticket } : {}), ...(agent ? { agent } : {}), data: data ?? {} };
    fs.appendFileSync(path.join(dir, `events-${month}.jsonl`), `${JSON.stringify(event)}\n`);
    return true;
  } catch {
    return false;
  }
}
