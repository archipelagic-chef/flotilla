import { spawn } from 'node:child_process';

/** Loose objects above this are packed: each one is a file, and git reads them one by one. */
export const LOOSE_OBJECT_LIMIT = 1000;

/** How often the repository is checked for loose objects. */
export const PACKING_CHECK_MS = 30 * 60_000;

/** A packing that runs longer than this is stopped (a hung git must not block later packs). */
export const PACKING_TIMEOUT_MS = 60 * 60_000;

export const MAINTENANCE_ARGS = ['maintenance', 'run', '--task=gc', '--task=pack-refs', '--task=commit-graph'] as const;

/** The loose object count from `git count-objects -v`. */
export function parseLooseCount(output: string): number {
  const match = /^count:\s*(\d+)/m.exec(output);
  return match ? Number(match[1]) : 0;
}

export function needsPacking(loose: number, limit: number = LOOSE_OBJECT_LIMIT): boolean {
  return loose > limit;
}

/** A history clean-up (a backlog item's rewrite) is in progress: packing must wait for it to finish. */
export function cleanUpInProgress(items: ReadonlyArray<{ rewrite?: unknown }>): boolean {
  return items.some((item) => item.rewrite !== undefined);
}

/** Runs the maintenance in cwd and resolves with git's exit code. Its output isn't kept: it may name local paths. */
export function packRepository(cwd: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...MAINTENANCE_ARGS], { cwd, stdio: 'ignore', windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
    const timer = setTimeout(() => child.kill(), PACKING_TIMEOUT_MS);
    child.on('error', (error) => (clearTimeout(timer), reject(error)));
    child.on('close', (code) => (clearTimeout(timer), resolve(code)));
  });
}
