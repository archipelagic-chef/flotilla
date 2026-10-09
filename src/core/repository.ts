/** Debounced snapshot store: the UI reads `current` and re-renders on change. */
export class Repository<T> {
  private items: readonly T[] = [];
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private rerun = false;
  private waiters: Array<() => void> = [];
  private disposed = false;

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
    let loaded = false;
    try {
      this.items = await this.load();
      loaded = true;
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
    if (loaded) {
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch (error) {
          this.onError(error);
        }
      }
    }
    waiters.forEach((w) => w());
    if (this.rerun && !this.disposed) {
      this.rerun = false;
      await this.run();
    }
  }
}
