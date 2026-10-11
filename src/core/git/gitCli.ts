import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
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
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function runGit(args: readonly string[], opts: RunGitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          reject(new GitError(args, typeof code === 'number' ? code : null, stderr || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** runGit, for output that may not be text (a file's bytes). */
export function runGitBytes(args: readonly string[], opts: RunGitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          reject(new GitError(args, typeof code === 'number' ? code : null, stderr.toString() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
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
