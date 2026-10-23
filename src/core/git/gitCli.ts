import { currentGitPriority, gitQueue } from './gitQueue';
import { type SpawnResult, spawnProcess } from './gitSpawner';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    /** What it printed before failing (some commands report through their exit code, e.g. merge-tree's conflicts). */
    readonly stdout = '',
  ) {
    super(`git ${args.join(' ')} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${stderr.trim() || 'no output'}`);
    this.name = 'GitError';
  }
}

export interface RunGitOptions {
  cwd: string;
  timeoutMs?: number;
  /** Extra environment variables, merged over the defaults. */
  env?: Record<string, string>;
  /** Written to git's standard input (for --stdin). */
  input?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Runs git and returns its text output. Waits its turn behind the other git processes (see gitQueue). */
export function runGit(args: readonly string[], opts: RunGitOptions): Promise<string> {
  return gitQueue.run(currentGitPriority(), () => execGit(args, opts));
}

/** Git processes running now, and the most at once since `peak` was last reset (the benchmark reads it). */
export const gitProcesses = { running: 0, peak: 0 };

const gitEnv = (env: Record<string, string> | undefined) => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env });

async function spawnGit<T extends string | Buffer>(args: readonly string[], opts: RunGitOptions, encoding: 'utf8' | 'buffer', maxBuffer: number) {
  gitProcesses.running++;
  gitProcesses.peak = Math.max(gitProcesses.peak, gitProcesses.running);
  try {
    const options = { cwd: opts.cwd, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer, encoding, windowsHide: true, env: gitEnv(opts.env) };
    return (await spawnProcess({ file: 'git', args: [...args], options, input: opts.input })) as SpawnResult<T>;
  } finally {
    gitProcesses.running--;
  }
}

async function execGit(args: readonly string[], opts: RunGitOptions): Promise<string> {
  const { error, stdout, stderr } = await spawnGit<string>(args, opts, 'utf8', 64 * 1024 * 1024);
  if (error) throw new GitError(args, typeof error.code === 'number' ? error.code : null, stderr || error.message, stdout);
  return stdout;
}

/** runGit, for output that may not be text (a file's bytes). */
export function runGitBytes(args: readonly string[], opts: RunGitOptions): Promise<Buffer> {
  return gitQueue.run(currentGitPriority(), () => execGitBytes(args, opts));
}

async function execGitBytes(args: readonly string[], opts: RunGitOptions): Promise<Buffer> {
  const { error, stdout, stderr } = await spawnGit<Buffer>(args, opts, 'buffer', 256 * 1024 * 1024);
  if (error) throw new GitError(args, typeof error.code === 'number' ? error.code : null, stderr.toString() || error.message);
  return stdout;
}

export type GitVersion = readonly [number, number, number];

export const MIN_GIT_VERSION: GitVersion = [2, 17, 0];

export function parseGitVersion(output: string): GitVersion | undefined {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function versionAtLeast(v: GitVersion, min: GitVersion): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

export async function getGitVersion(cwd: string): Promise<GitVersion | undefined> {
  try {
    return parseGitVersion(await runGit(['--version'], { cwd }));
  } catch {
    return undefined;
  }
}
