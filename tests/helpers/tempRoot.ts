import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The folder in the system temp folder that holds each test run's own temp folder, `run-<pid>-<random>`. */
const RUNS = 'flotilla-tests';

/** Whether a process with this pid is running (EPERM: it is, as another user's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes the run folders of runs that are no longer running: killed, or stopped before their teardown. */
export function sweepDeadRuns(runs: string, isAlive: (pid: number) => boolean = alive): void {
  let names: string[];
  try {
    names = fs.readdirSync(runs);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^run-(\d+)-/.exec(name)?.[1]);
    if (pid && !isAlive(pid)) fs.rmSync(path.join(runs, name), { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Makes this run's folder in `runs`, (re)making `runs` too: another run's teardown may remove it when it's empty. */
function makeRunDir(runs: string): string {
  for (let attempt = 0; ; attempt++) {
    fs.mkdirSync(runs, { recursive: true });
    try {
      return fs.mkdtempSync(path.join(runs, `run-${process.pid}-`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 5) throw err;
    }
  }
}

/**
 * Gives the test run a temp folder of its own: the workers (started after this) and everything they spawn see it as
 * the system temp folder, so what the tests and the code under test make there is removed with it at the end, also
 * when a test fails or times out.
 */
export default function setup(): () => void {
  const runs = path.join(fs.realpathSync.native(os.tmpdir()), RUNS);
  sweepDeadRuns(runs);
  const dir = fs.realpathSync.native(makeRunDir(runs));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    try {
      fs.rmdirSync(runs);
    } catch {
      // other runs still use it
    }
  };
}
