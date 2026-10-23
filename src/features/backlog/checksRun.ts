import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** How a background run of the checks ended: its exit code (undefined: it didn't start, or was killed), its output's end. */
export interface ChecksEnd {
  code: number | undefined;
  /** You stopped it. */
  stopped: boolean;
  /** The output's end (what the failure summary and the fixing agent read); all of it is in the log. */
  output: string;
  ms: number;
}

export interface BackgroundChecks {
  readonly done: Promise<ChecksEnd>;
  /** Stops the command and what it started (its process group). */
  stop(): void;
}

/**
 * Variables that make test runners print for an AI agent (vitest prints only failures then, not the test files as
 * they finish): the checks run for Flotilla, whoever started VS Code.
 */
const AGENT_MARKERS = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE'];

/** The checks' environment: the extension's, in colour, without the agent markers. */
export function checksEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: '1' };
  for (const k of AGENT_MARKERS) delete out[k];
  return out;
}

/**
 * Runs the checks in the background (BL-169), in dir: no task, no terminal. All of their output goes to the log file
 * (written over), and to onOutput as it comes. The command runs in a shell of its own process group (not on Windows),
 * so stopping it stops what the shell started too.
 */
export function runInBackground(dir: string, command: string, log: string, onOutput: (text: string) => void, env = checksEnv()): BackgroundChecks {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const file = fs.createWriteStream(log);
  const started = Date.now();
  let output = '';
  let stopped = false;
  let child: ChildProcess | undefined;
  const take = (text: string) => {
    // Only the end is kept in memory: that's where the failures are summed up.
    output = (output + text).slice(-200_000);
    file.write(text);
    onOutput(text);
  };
  const done = new Promise<ChecksEnd>((resolve) => {
    let ended = false;
    const end = (code: number | undefined) => {
      if (ended) return;
      ended = true;
      file.end(() => resolve({ code: stopped ? undefined : code, stopped, output, ms: Date.now() - started }));
    };
    // The command, at the top of the log only: it isn't the checks' output.
    file.write(`\x1b[2m${dir}> ${command}\x1b[0m\n`);
    child = spawn(command, { cwd: dir, shell: true, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (b: Buffer) => take(b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => take(b.toString('utf8')));
    child.on('error', (e) => {
      take(`\n${e.message}\n`);
      end(undefined);
    });
    child.on('close', (code) => end(code ?? undefined));
  });
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (child?.pid && child.exitCode === null) stopTree(child.pid);
    },
  };
}

/** Stops a process and the ones it started (the shell's command). */
export function stopTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // gone already
    }
  }
}
