import { AsyncLocalStorage } from 'node:async_hooks';
import * as os from 'node:os';

/** What a git process is for: an action or a view the user is waiting for, or a background refresh. */
export type GitPriority = 'foreground' | 'background';

/** Most git processes at once: one per CPU, at most 8, so a refresh of many worktrees can't swamp the machine. */
export const MAX_GIT_PROCESSES = Math.min(8, Math.max(1, os.cpus().length));

const priorityScope = new AsyncLocalStorage<GitPriority>();

/** Runs `task` with the git processes it starts queued as background work (behind foreground work). */
export function inBackground<T>(task: () => Promise<T>): Promise<T> {
  return priorityScope.run('background', task);
}

/** The priority of git processes started from here. */
export function currentGitPriority(): GitPriority {
  return priorityScope.getStore() ?? 'foreground';
}

/** Runs tasks with at most `limit` at once. Foreground tasks start before background ones; each lane is first in, first out. */
export class ProcessQueue {
  private running = 0;
  private readonly waiting: Record<GitPriority, Array<() => void>> = { foreground: [], background: [] };

  constructor(readonly limit: number) {}

  get active(): number {
    return this.running;
  }

  async run<T>(priority: GitPriority, task: () => Promise<T>): Promise<T> {
    await new Promise<void>((start) => {
      this.waiting[priority].push(start);
      this.pump();
    });
    try {
      return await task();
    } finally {
      this.running--;
      this.pump();
    }
  }

  private pump(): void {
    while (this.running < this.limit) {
      const next = this.waiting.foreground.shift() ?? this.waiting.background.shift();
      if (!next) return;
      this.running++;
      next();
    }
  }
}

export const gitQueue = new ProcessQueue(MAX_GIT_PROCESSES);
