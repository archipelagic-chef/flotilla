import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type ActivityLevel = 'active' | 'idle' | 'stale';

/** Changed files whose mtimes are checked for activity (more than this, and progress is not reused). */
export const MAX_PATHS = 200;

/** Newest mtime among changed files and the worktree's HEAD reflog. Never stats .git/index (git status may touch it). */
export async function lastActivity(worktreeDir: string, gitDir: string, changedPaths: readonly string[]): Promise<Date | undefined> {
  const candidates = [...changedPaths.slice(0, MAX_PATHS).map((p) => path.join(worktreeDir, p)), path.join(gitDir, 'logs', 'HEAD')];
  let latest: number | undefined;
  for (const file of candidates) {
    try {
      const { mtimeMs } = await fs.stat(file);
      if (latest === undefined || mtimeMs > latest) latest = mtimeMs;
    } catch {
      // deleted files have no mtime
    }
  }
  return latest === undefined ? undefined : new Date(latest);
}

export function classifyActivity(last: Date | undefined, now: Date, activeMinutes: number, staleDays: number): ActivityLevel {
  if (!last) return 'stale';
  const age = now.getTime() - last.getTime();
  if (age <= activeMinutes * 60_000) return 'active';
  if (age >= staleDays * 86_400_000) return 'stale';
  return 'idle';
}
