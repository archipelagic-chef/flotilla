import type { BacklogItem } from '../../features/backlog/backlog';
import type { LocalBacklog } from '../../features/backlog/localBacklog';
import {
  baseName,
  type MergeInfo,
  movesToDone,
} from '../../features/backlog/merged';
import { MergeReader } from '../../features/backlog/mergeReader';
import { entryDate } from '../../features/backlog/ticket';
import { resolveBase } from '../../features/workstreams/progress';
import { readSettings } from '../settings';

export interface MergesDeps {
  backlog: LocalBacklog;
  mainRoot: string;
  /** An item Flotilla is merging itself now (Merge to main): it moves it to Done, saying what it merged. */
  merging?(id: string): boolean;
}

/**
 * Whether the local items' work is merged into the base, as git says now (see mergeReader.ts). Refreshed when the
 * repository reloads (refs move, polling) and when the backlog changes. An item whose branches are all merged moves to
 * Done by itself, noted in its activity: a merge done on the command line counts too.
 */
export class Merges {
  private readonly reader: MergeReader;
  private readonly listeners = new Set<() => void>();
  private info = new Map<string, MergeInfo>();
  /** Items seen with unmerged work since Flotilla started: their merge (outside Flotilla too) moves them to Done. */
  private readonly open = new Set<string>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MergesDeps) {
    this.reader = new MergeReader(deps.mainRoot);
  }

  /** The item's merge state (undefined: no branch, or no base to compare with). */
  get(id: string): MergeInfo | undefined {
    return this.info.get(id);
  }

  /** Called when the merge states change. */
  watch(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Reads the merge states again, and moves what's merged to Done. One refresh at a time. */
  refresh(): Promise<void> {
    this.running = this.running.then(() => this.read()).catch(() => undefined);
    return this.running;
  }

  private async read(): Promise<void> {
    const data = await this.deps.backlog.read();
    const base = await resolveBase(this.deps.mainRoot, readSettings().defaultBase);
    const info = await this.reader.read(data.items, base);
    const before = JSON.stringify([...this.info]);
    this.info = info;
    for (const [id, merge] of info) if (merge.state === 'unmerged' || merge.state === 'partly') this.open.add(id);
    const done = data.items.filter((i) => movesToDone(i, info.get(i.id), this.open.has(i.id)) && !(i.merging || this.deps.merging?.(i.id)));
    if (done.length) await this.settle(done, info);
    if (before !== JSON.stringify([...this.info])) for (const listener of [...this.listeners]) listener();
  }

  /** Moves merged items to Done, with a note in each one's activity. */
  private async settle(items: BacklogItem[], info: Map<string, MergeInfo>): Promise<void> {
    const ids = new Set(items.map((i) => i.id));
    for (const id of ids) this.open.delete(id);
    // Only what's still open when it's written: a merge that finished meanwhile has said so already.
    const moved = new Set<string>();
    await this.deps.backlog.change(
      (d) => ({
        ...d,
        items: d.items.map((i) => (ids.has(i.id) && i.status !== 'done' && !i.merging ? (moved.add(i.id), { ...i, status: 'done' }) : i)),
      }),
      { by: 'Flotilla' },
    );
    for (const item of items.filter((i) => moved.has(i.id))) {
      await this.deps.backlog.appendActivity(item, {
        date: entryDate(new Date()),
        author: 'Flotilla',
        body: `Its work is all in ${baseName(info.get(item.id)!.base)}, so it's done.`,
      });
    }
  }
}
