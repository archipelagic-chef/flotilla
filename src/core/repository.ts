/** Debounced snapshot store: the UI reads `current` and re-renders on change. */
export class Repository<T> {
  private items: readonly T[] = [];
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private waiters: Array<() => void> = [];
  private disposed = false;
  /** Bumped by patch(); a load that started before a patch is stale and is redone. */
  private version = 0;

  constructor(
    private readonly load: () => Promise<readonly T[]>,
    private readonly debounceMs = 300,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  get current(): readonly T[] {
    return this.items;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Applies a quick partial update now (e.g. one worktree's git status) without waiting for a full load. */
  patch(update: (items: readonly T[]) => readonly T[]): void {
    if (this.disposed) return;
    this.items = update(this.items);
    this.version++;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
    }
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.run();
      }, this.debounceMs);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
    this.waiters.splice(0).forEach((w) => w());
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    const waiters = this.waiters.splice(0);
    const startedAt = this.version;
    let loaded = false;
    let stale = false;
    try {
      const items = await this.load();
      // Patched while loading: this result may predate the patch. Load again rather than undo it.
      stale = this.version !== startedAt;
      if (!stale) {
        this.items = items;
        loaded = true;
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
    if (loaded) this.notify();
    if (stale && !this.disposed) {
      // The callers waiting for this load get the next one.
      this.waiters.unshift(...waiters);
      this.rerun = false;
      await this.run();
      return;
    }
    waiters.forEach((w) => w());
    if (this.rerun && !this.disposed) {
      this.rerun = false;
      await this.run();
    }
  }
}
