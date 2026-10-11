import * as fs from 'node:fs';
import * as path from 'node:path';

/** Each watched folder takes an inotify watch, and the limit is shared by every window: keep it modest. */
const MAX_WATCHED = 100;
const DEBOUNCE_MS = 200;

interface Watched {
  key: string;
  rel: string;
  watcher: fs.FSWatcher;
}

/**
 * Watches the folders the Files tab lists, one level each, so that the tab updates when files are created or deleted
 * in them. The window's own watcher can't do this for worktrees: files.watcherExclude hides .worktrees from it. The
 * least recently listed folder is dropped when there are too many.
 */
export class ShownFolders {
  private readonly watched = new Map<string, Watched>();
  private readonly pending = new Map<string, { key: string; rel: string }>();
  private timer: NodeJS.Timeout | undefined;

  /** changed is called once per folder that changed, after a short pause (so a burst of writes is one call). */
  constructor(private readonly changed: (key: string, rel: string) => void) {}

  /** Watches folder rel of worktree key, whose root is root. A folder already watched becomes the most recent. */
  watch(key: string, root: string, rel: string): void {
    const dir = path.join(root, rel);
    const existing = this.watched.get(dir);
    if (existing) {
      this.watched.delete(dir);
      this.watched.set(dir, existing);
      return;
    }
    if (this.watched.size >= MAX_WATCHED) this.close(this.watched.keys().next().value!);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, () => {
        if (!fs.existsSync(dir)) this.close(dir);
        this.schedule(key, rel);
      });
    } catch {
      // Gone, or not watchable here: the Files tab then just doesn't update on its own.
      return;
    }
    watcher.on('error', () => this.close(dir));
    this.watched.set(dir, { key, rel, watcher });
  }

  /** Stops watching the folders of worktrees that aren't in keys any more. */
  retain(keys: ReadonlySet<string>): void {
    for (const [dir, w] of this.watched) if (!keys.has(w.key)) this.close(dir);
  }

  dispose(): void {
    for (const dir of [...this.watched.keys()]) this.close(dir);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private schedule(key: string, rel: string): void {
    this.pending.set(`${key}\0${rel}`, { key, rel });
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const { key, rel } of batch) this.changed(key, rel);
    }, DEBOUNCE_MS);
  }

  private close(dir: string): void {
    const w = this.watched.get(dir);
    if (!w) return;
    this.watched.delete(dir);
    w.watcher.close();
  }
}
