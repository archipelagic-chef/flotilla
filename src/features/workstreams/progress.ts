import { runGit } from '../../core/git/gitCli';
import { sumNumstat } from '../../core/git/porcelain';

export interface Progress {
  base: string | undefined;
  ahead: number;
  behind: number;
  added: number;
  deleted: number;
  lastSubject: string | undefined;
}

async function isCommit(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function resolveBase(cwd: string, configured: string): Promise<string | undefined> {
  if (configured && (await isCommit(cwd, configured))) return configured;
  try {
    const originHead = (await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd })).trim();
    if (originHead) return originHead;
  } catch {
    // no origin/HEAD
  }
  for (const candidate of ['main', 'master']) {
    if (await isCommit(cwd, candidate)) return candidate;
  }
  return undefined;
}

export async function computeProgress(worktreeDir: string, base: string | undefined): Promise<Progress> {
  const progress: Progress = { base, ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: undefined };
  const cwd = worktreeDir;
  try {
    progress.lastSubject = (await runGit(['log', '-1', '--format=%s'], { cwd })).trim() || undefined;
  } catch {
    return progress; // no commits yet
  }
  if (!base) return progress;
  try {
    const [behind, ahead] = (await runGit(['rev-list', '--left-right', '--count', `${base}...HEAD`], { cwd })).trim().split(/\s+/).map(Number);
    progress.ahead = ahead;
    progress.behind = behind;
    const mergeBase = (await runGit(['merge-base', base, 'HEAD'], { cwd })).trim();
    Object.assign(progress, sumNumstat(await runGit(['diff', '--numstat', '-z', mergeBase], { cwd })));
  } catch {
    // unknown base or unrelated histories: keep zeros
  }
  return progress;
}
