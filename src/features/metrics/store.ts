import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MetricsPeriod, MetricsView } from '../../webview/metricsProtocol';
import { computeMetrics, EventIndex } from './compute';
import { eventsDir, parseEvents } from './events';

/**
 * The event log as the Metrics view reads it (BL-158): each month's file is read once, and then only what was appended
 * to it since (the files only grow), so a year of events is parsed once per window, not on every look.
 */
export class MetricsStore {
  private readonly index = new EventIndex();
  /** How far each file has been read (bytes, up to its last whole line). */
  private readonly read = new Map<string, number>();
  private reading: Promise<void> | undefined;

  constructor(private readonly commonDir: string) {}

  /** Reads what was added to the log since the last time. */
  refresh(): Promise<void> {
    // One read at a time: a second waits for the first, then reads what came meanwhile.
    const next = (this.reading ?? Promise.resolve()).then(() => this.readNew());
    this.reading = next.catch(() => undefined);
    return next;
  }

  async view(period: MetricsPeriod, now = Date.now(), opts: { limit?: number; criteria?: ReadonlyMap<string, number> } = {}): Promise<MetricsView> {
    await this.refresh();
    return computeMetrics(this.index, period, now, opts);
  }

  private async readNew(): Promise<void> {
    const dir = eventsDir(this.commonDir);
    const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((n) => /^events-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
    for (const n of names) {
      const file = path.join(dir, n);
      const from = this.read.get(file) ?? 0;
      const size = (await fs.promises.stat(file).catch(() => undefined))?.size ?? 0;
      if (size === from) continue;
      // A file only shrinks when it's rewritten by hand: its events are kept as they were read.
      if (size < from) {
        this.read.set(file, size);
        continue;
      }
      const start = from;
      const handle = await fs.promises.open(file, 'r');
      try {
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        // Up to the last whole line: a line being written is read next time.
        const end = buffer.lastIndexOf(10) + 1;
        if (!end) continue;
        this.index.add(parseEvents(buffer.subarray(0, end).toString('utf8')));
        this.read.set(file, start + end);
      } finally {
        await handle.close();
      }
    }
  }
}
