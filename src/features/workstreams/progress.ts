import { runGit } from '../../core/git/gitCli';
import { sumNumstat } from '../../core/git/porcelain';

export interface Progress {
  base: string | undefined;
  /** The commit the base named when this was computed. */
  baseHead: string | undefined;
  ahead: number;
  behind: number;
  added: number;
  deleted: number;
  lastSubject: string | undefined;
}

/** The commit a ref names, or undefined if it names none. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return (await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).trim() || undefined;
  } catch {
    return undefined;
  }
}

const isCommit = async (cwd: string, ref: string): Promise<boolean> => (await resolveCommit(cwd, ref)) !== undefined;

/** The local branch of a remote one ("origin/main": main), when it has commits the remote one doesn't; else undefined. */
async function localAhead(cwd: string, remote: string): Promise<string | undefined> {
  const local = remote.slice(remote.indexOf('/') + 1);
  if (!local || !(await isCommit(cwd, `refs/heads/${local}`))) return undefined;
  try {
    const ahead = Number((await runGit(['rev-list', '--count', `${remote}..refs/heads/${local}`], { cwd })).trim());
    return ahead > 0 ? local : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The branch work starts from and merges into: the configured one, else origin's default branch (origin/main), else
 * main or master. When the local branch of origin's default (main) has commits origin doesn't (work not pushed yet,
 * BL-86), it's that local branch: starting from origin/main would leave that work out, and branches would conflict with
 * main when merged.
 */
export async function resolveBase(cwd: string, configured: string): Promise<string | undefined> {
  if (configured && (await isCommit(cwd, configured))) return configured;
  try {
    const originHead = (await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd })).trim();
    if (originHead) return (await localAhead(cwd, originHead)) ?? originHead;
  } catch {
    // no origin/HEAD
  }
  for (const candidate of ['main', 'master']) {
    if (await isCommit(cwd, candidate)) return candidate;
  }
  return undefined;
}

export async function computeProgress(worktreeDir: string, base: string | undefined, baseHead: string | undefined): Promise<Progress> {
  const progress: Progress = { base, baseHead, ahead: 0, behind: 0, added: 0, deleted: 0, lastSubject: undefined };
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
    // Plumbing diff-index never refreshes or writes the index (porcelain `git diff` does when files are stat-dirty).
    Object.assign(progress, sumNumstat(await runGit(['diff-index', '--numstat', '-z', mergeBase], { cwd })));
  } catch {
    // unknown base or unrelated histories: keep zeros
  }
  return progress;
}
