/**
 * The worktrees being removed in this window (by key), from the confirmation until they're gone or the removal failed
 * (BL-119): `git worktree remove` and deleting the branch take seconds on a big worktree, and its row shows it meanwhile.
 */
export class RemovingWorktrees {
  private readonly removing = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** Whether the worktree is being removed now. */
  has(key: string): boolean {
    return this.removing.has(key);
  }

  /** Runs remove with the worktree marked as being removed; it's unmarked when remove ends, whether it worked or not. */
  async run<T>(key: string, remove: () => Promise<T>): Promise<T> {
    this.removing.add(key);
    this.fire();
    try {
      return await remove();
    } finally {
      this.removing.delete(key);
      this.fire();
    }
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }
}

/** This window's (every view shares it). */
export const removingWorktrees = new RemovingWorktrees();
