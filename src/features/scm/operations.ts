import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit, type RunGitOptions } from '../../core/git/gitCli';
import type { FileChange } from '../../core/git/porcelain';

/** Commit hooks and network operations can take a while. */
const LONG_TIMEOUT_MS = 300_000;
/** Keeps command lines well below Windows' length limit. */
const PATHS_PER_CALL = 100;

/** Paths are literal (no glob magic); merges and pulls never wait for an editor. */
const ENV = { GIT_LITERAL_PATHSPECS: '1', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: ':' };

function git(dir: string, args: string[], opts: Partial<RunGitOptions> = {}): Promise<string> {
  return runGit(args, { cwd: dir, ...opts, env: { ...ENV, ...opts.env } });
}

async function inChunks(paths: readonly string[], run: (chunk: string[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < paths.length; i += PATHS_PER_CALL) await run(paths.slice(i, i + PATHS_PER_CALL));
}

async function hasHead(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Stages the paths, including deletions; staging a conflicted file marks it resolved. */
export function stage(dir: string, paths: readonly string[]): Promise<void> {
  return inChunks(paths, (chunk) => git(dir, ['add', '-A', '--', ...chunk]));
}

export async function stageAll(dir: string): Promise<void> {
  await git(dir, ['add', '-A']);
}

export async function unstage(dir: string, paths: readonly string[]): Promise<void> {
  const head = await hasHead(dir);
  await inChunks(paths, (chunk) => git(dir, head ? ['reset', '-q', 'HEAD', '--', ...chunk] : ['rm', '--cached', '-r', '-q', '--', ...chunk]));
}

export async function unstageAll(dir: string): Promise<void> {
  if (await hasHead(dir)) await git(dir, ['reset', '-q']);
  else await git(dir, ['rm', '--cached', '-r', '-q', '.']);
}

/** Throws away unstaged changes: tracked files go back to their staged version, untracked files are deleted. */
export async function discard(dir: string, changes: readonly FileChange[]): Promise<void> {
  const conflicted = changes.find((c) => c.kind === 'conflicted');
  if (conflicted) throw new Error(`${conflicted.path} has merge conflicts; resolve or stage it instead of discarding.`);
  for (const change of changes.filter((c) => c.kind === 'untracked')) {
    await fs.rm(path.join(dir, change.path), { recursive: true, force: true });
  }
  const tracked = changes.filter((c) => c.kind !== 'untracked').map((c) => c.path);
  await inChunks(tracked, (chunk) => git(dir, ['checkout', '-q', '--', ...chunk]));
}

export async function commit(dir: string, message: string): Promise<void> {
  await git(dir, ['commit', '-q', '-m', message], { timeoutMs: LONG_TIMEOUT_MS });
}

export async function listRemotes(dir: string): Promise<string[]> {
  return (await git(dir, ['remote'])).split('\n').map((r) => r.trim()).filter(Boolean);
}

/** Pushes the branch to the remote and makes it the upstream. */
export async function publish(dir: string, branch: string, remote: string): Promise<void> {
  await git(dir, ['push', '-u', remote, `HEAD:refs/heads/${branch}`], { timeoutMs: LONG_TIMEOUT_MS });
}

export async function push(dir: string): Promise<void> {
  await git(dir, ['push'], { timeoutMs: LONG_TIMEOUT_MS });
}

/** Pulls from the upstream, honouring the user's pull.rebase / pull.ff configuration. */
export async function pull(dir: string): Promise<void> {
  await git(dir, ['pull'], { timeoutMs: LONG_TIMEOUT_MS });
}

export async function sync(dir: string): Promise<void> {
  await pull(dir);
  await push(dir);
}

export async function fetch(dir: string): Promise<void> {
  await git(dir, ['fetch', '--all', '--prune'], { timeoutMs: LONG_TIMEOUT_MS });
}
